# ARCHITECTURE

Este documento registra as decisões, os trade-offs e as limitações da solução. A regra que guiou tudo: **o banco é o árbitro final das invariantes**. O código de aplicação existe para produzir as respostas certas rapidamente; o schema existe para que, mesmo com um bug no código, o estado errado não possa ser confirmado.

## 1. Visão geral

```
            HTTP (POST /wagering/transactions)          SQS wager-transactions.fifo
                         │                                        │
                         ▼                                        ▼
                 WageringController                    SqsWagerConsumer ─► WagerMessageHandler
                         │                                        │   (ack / retry / DLQ)
                         └──────────────► ProcessWagerTransactionUseCase ◄──┘   (mesmo use case)
                                                  │  1 transação SQL
                     ┌──────────────┬─────────────┼──────────────┬──────────────┐
                     ▼              ▼             ▼              ▼              ▼
                  inbox        wallet (FOR     wager_tx       ledger         outbox
              (consumer,msg)    UPDATE + CAS)  (idempotência) (append-only)  (eventos)
                                                                                │
           PendingReference worker (SKIP LOCKED) ──► WagerProcessor            │
           Outbox relay (lease + SKIP LOCKED) ◄────────────────────────────────┘
                     │
                     ▼
              SQS wagering-events.fifo
```

Um único binário com papéis (`APP_ROLE=api|worker|all`). No Compose: 1 API + 3 workers; qualquer número de instâncias de cada papel é seguro.

## 2. Camadas e fronteiras

| Camada | Conteúdo | Depende de |
|---|---|---|
| `domain` | `Money`, `Wallet` (aggregate root), `WagerTransaction` (máquina de estados), `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos de integração, `WagerSettlement` (serviço de domínio puro) | nada (nem NestJS, nem ORM) |
| `application` | portas (`UnitOfWork`, repositórios, `Clock`, `IdGenerator`, `Metrics`, `AppLogger`, `EventPublisher`), use cases, `WagerProcessor`, hash de payload | `domain` |
| `infrastructure` | NestJS (controllers, filtro, guard, módulo), MikroORM, repositórios SQL, SQS, Prometheus, workers | tudo acima |

- Todas as entidades seguem a regra 6.0: construtor `private`, factories `create`/`open`/`from` (validam) e `rehydrate` (só reconstrói, não revalida).
- `WagerSettlement.settle()` decide **o que** uma transação faz com uma wallet (inclusive referências, reversões e saldo insuficiente) sem I/O, então todas as regras são testáveis unitariamente. `WagerProcessor` aplica a política de retry de referências e persiste as consequências.
- `Wallet.debit/credit` são a única forma de mudar saldo e **retornam** o `WalletLedgerEntry` correspondente: saldo e ledger não têm como divergir dentro do modelo. O lançamento é criado (e validado) antes de mutar o agregado; se falhar, o agregado fica intocado.

## 3. Money

- Representação interna: **`bigint` em unidades menores com escala fixa 2**. É exato por construção, não há ponto flutuante em nenhum caminho e o domínio não depende de biblioteca decimal nem de tipos do ORM. Como a escala é fixa e entradas com mais de 2 casas são rejeitadas, **nenhuma operação precisa arredondar** (a assinatura de referência usava `Decimal`; a garantia é a mesma, com uma dependência a menos).
- Entrada estrita: só string decimal não negativa, sem sinal, sem expoente, sem zeros à esquerda, até 2 casas e até 18 dígitos inteiros (cabe em `numeric(20,2)`). `number` é rejeitado mesmo quando "parece" válido (`25`, `0.1`).
- Saída sempre com 2 casas (`"25"` → `"25.00"`). A normalização também vale para o hash de idempotência.
- Persistência: `numeric(20,2)` + `char(3)` em colunas separadas. Os drivers devolvem `numeric` como **string**, que volta para `Money.from` sem passar por `number`.
- Multi-moeda: o modelo inteiro é multi-moeda (wallet por `playerId + currency`); operações entre moedas lançam `CurrencyMismatchError` no domínio e viram `REJECTED CURRENCY_MISMATCH` no fluxo.

## 4. ORM: MikroORM e estratégia transacional

**Escolha: MikroORM 6** (a opção preferencial). Ele é usado para:

- pool de conexões e driver PostgreSQL;
- **demarcação de transação**: `orm.em.fork().transactional(em => …)`; tudo executado pelo `em` forkado participa da mesma transação; commit no retorno, rollback no throw;
- **migrations versionadas e reversíveis** (`Migrator`, `migrationsList` explícita, `up`/`down`).

Decisão consciente: **não uso o change-set do Unit of Work (flush) no caminho do dinheiro.** O caminho de escrita precisa de:

- `SELECT … FOR UPDATE` em uma wallet;
- `UPDATE … WHERE id = ? AND version = ?` (compare-and-set com verificação de linhas afetadas);
- `INSERT … ON CONFLICT DO NOTHING RETURNING` (inbox);
- `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` (claims da outbox e do worker).

Misturar isso com flush do UoW criaria dois modelos de escrita e esconderia a ordem real dos statements. Os repositórios escrevem SQL explícito (via a porta `SqlExecutor`, executada por `em.execute()` dentro da transação do MikroORM), e cada statement do caminho financeiro fica revisável em um só arquivo (`sql-repositories.ts`). O padrão Unit of Work continua existindo como **porta da aplicação** (`UnitOfWork.transactional(repos => …)`): todos os repositórios recebidos compartilham a transação. O mapeamento `Money` ↔ `numeric` está em `mappers.ts`.

Trade-off aceito: perde-se o identity map e o dirty checking do ORM. Ganha-se previsibilidade total do SQL sob concorrência, que é exatamente o que este desafio avalia.

Cada transação faz `SET LOCAL lock_timeout` (padrão 5s) e `statement_timeout` (15s): espera patológica em wallet quente vira erro **transitório** (`55P03`) em vez de prender conexões indefinidamente.

## 5. Concorrência

**Unidade de concorrência: `walletId`.** Estratégia em camadas:

1. **Lock pessimista por linha** (`SELECT … FROM wallets WHERE id = ? FOR UPDATE`) como **primeiro** statement relevante do use case. Tudo que vem depois (checagem de idempotência, resolução de referência, saldo) enxerga o último estado confirmado daquela wallet. Wallets diferentes não compartilham lock nenhum.
2. **Compare-and-set em `version`** no `UPDATE` do saldo (`WHERE version = expected`, 0 linhas → `ConcurrencyConflictError` → retry limitado). É defesa em profundidade.
3. **Constraints e triggers do schema** (seção 7): mesmo que (1) e (2) falhassem, o commit seria rejeitado.

Por que pessimista e não só otimista: em wallet quente (muitas apostas na mesma wallet), o otimista gera tempestade de retries, latência imprevisível e falhas por retries esgotados. Com `FOR UPDATE`, as requisições fazem fila no lock e cada uma roda uma vez. O lock dura só a transação curta (sem I/O externo dentro dela: nada de SQS dentro da transação).

**Ordem de locks** (sem deadlock): sempre wallet → linhas de transação. Os claims dos workers são transações curtas separadas que não esperam por nada e nunca seguram locks enquanto travam wallets.

**Experimento de mutação** (feito durante o desenvolvimento): removendo o `FOR UPDATE`, **nenhum invariante foi violado** (o CAS de `version` e os `UNIQUE`/triggers barraram tudo); as falhas observadas foram de *liveness* (retries esgotados sob contenção). É a evidência de que o schema, e não o código, é a garantia final.

Cenário obrigatório (100.00, duas apostas de 80.00 simultâneas): uma `PROCESSED`, outra `REJECTED INSUFFICIENT_FUNDS`, saldo 20.00, exatamente um débito. Testado 10× por execução, mais 50 envios paralelos da mesma aposta, 200 operações mistas numa wallet quente, wallets distintas em paralelo com uma wallet travada, e 4 processos do SO simultâneos.

## 6. Idempotência

- **Fonte da verdade:** header `Idempotency-Key` (HTTP) / `data.idempotencyKey` (SQS). Default recomendado `"{providerId}:{externalTransactionId}"`, não imposto.
- **Persistente:** `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` em `wager_transactions`. Nada em memória.
- **Algoritmo do `payloadHash`:**
  ```
  sha256_hex( canonicalJson({ providerId, externalTransactionId, playerId, walletId, roundId,
                              gameId, kind, money: { amount, currency }, referenceExternalTransactionId? }) )
  ```
  `canonicalJson` = chaves ordenadas recursivamente, sem espaços, campos `undefined` omitidos. `amount` entra **normalizado** (`"25"` ≡ `"25.00"`), e UUIDs em minúsculas. O header e metadados de transporte (`messageId`, `occurredAt`, correlation id) **não** entram.
- **Mesma key + mesmo hash** → replay: devolve o resultado armazenado (`status`, `failureCode`, **`balance` observado na época**, guardado em `result_balance`) com `idempotentReplay: true`.
- **Mesma key + hash diferente** → `409 IDEMPOTENCY_KEY_CONFLICT` (nunca replay).
- **Mesmo `(providerId, externalTransactionId)` com outra key** → `409 DUPLICATE_EXTERNAL_TRANSACTION_ID`.
- **Corrida:** duas requisições com a mesma key em wallets diferentes não se serializam pelo lock; a segunda bate no `UNIQUE`, a transação faz rollback e o use case tenta de novo (até 3×), caindo no caminho de replay/conflito.
- Replay de transação ainda `PENDING_REFERENCE` devolve o estado atual (202); quando ela termina, o replay devolve o resultado final.

## 7. Garantias aplicadas no schema

| Invariante | Como o banco garante |
|---|---|
| saldo nunca negativo | `CHECK (balance >= 0)` em `wallets`; `CHECK (balance_after >= 0)` no ledger |
| no máximo uma wallet por player+moeda | `UNIQUE (player_id, currency)` |
| toda alteração de saldo tem lançamento (e vice-versa) | `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` em `wallets`: no **commit**, a versão/saldo da wallet precisa ter o lançamento com aquele `wallet_version` e aquele `balance_after` |
| sem lost update | `UNIQUE (wallet_id, wallet_version)` no ledger + trigger que exige `version = old + 1` sempre que o saldo muda (e proíbe mudar a versão sem mudar o saldo) |
| lançamento aritmeticamente correto | `CHECK` `balance_after = balance_before ± amount` |
| cadeia do ledger contínua | trigger `BEFORE INSERT`: cada entrada começa no `balance_after` da anterior (`version - 1`); a primeira começa em 0; moeda e valor batem com wallet e transação |
| ledger imutável | triggers rejeitam `UPDATE`, `DELETE` e `TRUNCATE` |
| ≤ 1 lançamento por transação por wallet | `UNIQUE (transaction_id, wallet_id)` |
| idempotência | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` |
| referência revertida no máximo uma vez | índice único parcial `(reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'` |
| REFUND/ROLLBACK exigem referência; BET/OPENING não têm | `CHECK ck_wager_tx_reference_required` |
| OPENING é interno | `CHECK ((kind = 'OPENING') = (provider_id = 'internal'))` (e `internal` é reservado na entrada) |
| estados terminais são finais | trigger rejeita qualquer `UPDATE` em linha `PROCESSED/REJECTED/FAILED`, alteração de colunas de identidade/negócio e `DELETE` |
| coerência de status | `CHECK`s: `failure_code` ⇔ `REJECTED/FAILED`; `processed_at` ⇔ terminal; `next_retry_at` ⇔ `PENDING_REFERENCE` |
| evento publicado não "despublica" | trigger na outbox impede reabrir `published_at` e alterar o evento |

Os testes em `test/integration/schema.test.ts` ignoram a aplicação e atacam as tabelas diretamente para provar cada linha acima.

## 8. Máquina de estados de `WagerTransaction`

```
PENDING ───────────► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE ─► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (contabiliza tentativa)
PROCESSED, REJECTED, FAILED: terminais (transição = InvalidTransactionStateError, erro de programação)
```

`PENDING` existe no modelo; na prática a transação é avaliada dentro da mesma transação SQL em que nasce, então é persistida já no estado resultante. `FAILED` é usado quando o reprocessamento de uma `PENDING_REFERENCE` encontra um erro permanente inesperado (fica auditável e para de tentar).

## 9. Regras de negócio e interpretações adotadas

| Operação | Saldo | Ledger | Regra |
|---|---|---|---|
| BET | débito | 1 DEBIT | `INSUFFICIENT_FUNDS` se saldo < valor |
| WIN | crédito | 1 CREDIT | referência opcional à BET da rodada |
| LOSS | — | — | referência opcional; registra resultado |
| REFUND | crédito | 1 CREDIT | só de BET `PROCESSED`, valor igual, uma vez |
| ROLLBACK | inverso da referência | 1 entrada invertida | de BET (crédito), WIN ou REFUND (débito), valor igual, uma vez |

Interpretações (todas testadas):

1. **Uma reversão por referência, não "por tipo".** O enunciado proíbe reverter duas vezes "pelo mesmo tipo"; permitir REFUND **e** ROLLBACK da mesma BET creditaria o valor duas vezes. Adotei a regra mais estrita: a referência aceita uma única reversão `PROCESSED` (REFUND ou ROLLBACK), garantida por índice único parcial → `REFERENCE_ALREADY_REVERSED`. ROLLBACK de um REFUND continua permitido (é outra referência).
2. ROLLBACK não referencia ROLLBACK nem LOSS (`REFERENCE_KIND_NOT_ALLOWED`).
3. A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ter o mesmo provider, player, wallet, moeda e rodada (`REFERENCE_MISMATCH`).
4. Referência existente mas ainda pendente → a dependente também espera. Referência `REJECTED/FAILED` → `REFERENCE_NOT_PROCESSED`.
5. Valores: BET/WIN/REFUND/ROLLBACK exigem valor > 0; LOSS aceita `0.00`.
6. **Wallet inexistente** não gera transação persistida (a FK exige a wallet): `422 WALLET_NOT_FOUND`. Player que não é dono da wallet gera `REJECTED PLAYER_WALLET_MISMATCH` (auditável).
7. Reversão que deixaria o saldo negativo → `REJECTED REVERSAL_INSUFFICIENT_FUNDS`, distinto de `INSUFFICIENT_FUNDS`.
8. Saldo inicial > 0 gera transação interna `OPENING` (`provider_id = 'internal'`, nasce `PROCESSED`) + CREDIT `wallet_version = 1` + `WalletBalanceChanged`, na mesma transação SQL. A wallet nasce na versão 1 já com o saldo inicial.

## 10. Referências fora de ordem

- Referência ausente → transação persistida como `PENDING_REFERENCE` com `reference_attempts = 1` e `next_retry_at`; evento `WagerTransactionPendingReference`; HTTP `202`.
- **Resolução imediata:** quando uma transação chega a um estado terminal, o `WagerProcessor` busca as `PENDING_REFERENCE` da **mesma wallet** que esperavam por ela e as liquida na mesma transação, sob o lock que já está seguro (recursivo, profundidade ≤ 5). No caso comum o backoff nem é usado.
- **Worker agendado** (fallback): faz claim das vencidas com `FOR UPDATE SKIP LOCKED` empurrando `next_retry_at` (lease), comita, e liquida cada uma numa transação própria que trava **a wallet primeiro** e relê a linha (se outro já liquidou, pula). Seguro com N workers.
- **Backoff exponencial** 1s → 2s → 4s … teto 60s, **10 tentativas** (~4 min). Justificativa: reordenação real entre BET e REFUND/ROLLBACK é de milissegundos a segundos (consumidores paralelos, redelivery do broker); se em minutos a referência não chegou, o problema está no provedor e uma rejeição explícita (`REFERENCE_NOT_FOUND` + `WagerTransactionRejected`) é mais útil do que esperar indefinidamente. Tudo configurável por env.

## 11. Taxonomia de falhas

Transação persistida (`failureCode`):

| Código | Categoria | O que o provedor deve fazer |
|---|---|---|
| `INSUFFICIENT_FUNDS` | business | não reenviar |
| `REVERSAL_INSUFFICIENT_FUNDS` | business | investigar/reconciliar; não reenviar |
| `CURRENCY_MISMATCH` | business | corrigir payload (nova transação) |
| `PLAYER_WALLET_MISMATCH` | business | corrigir payload |
| `REFERENCE_NOT_FOUND` | reference | reenviar a referência e depois a reversão com **novo** id |
| `REFERENCE_MISMATCH` | reference | corrigir dados da referência |
| `REFERENCE_KIND_NOT_ALLOWED` | reference | corrigir o tipo/referência |
| `REFERENCE_NOT_PROCESSED` | reference | nada a reverter; desistir |
| `REFERENCE_ALREADY_REVERSED` | reference | desistir (já revertida) |
| `REFERENCE_AMOUNT_MISMATCH` | reference | corrigir valor (reversão parcial fora de escopo) |
| `PROCESSING_FAILED` | infrastructure (`FAILED`) | escalar; auditável |

Erros de requisição (sem transação persistida): `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_CONFLICT`, `DUPLICATE_EXTERNAL_TRANSACTION_ID`, `WALLET_NOT_FOUND`, `WALLET_ALREADY_EXISTS`, `NOT_FOUND`, `UNAUTHORIZED`, `INFRASTRUCTURE_UNAVAILABLE`, `INTERNAL_ERROR`. Todo corpo de erro traz `{ error: { code, message, field?, retryable } }`.

## 12. HTTP: mapeamento de status

Um único mapeamento (`error-mapping.ts`), igual para todos os endpoints:

| Situação | Status |
|---|---|
| payload inválido | `400 VALIDATION_ERROR` |
| recurso do path não existe | `404 NOT_FOUND` |
| conflito de idempotência / identidade / wallet duplicada | `409` |
| rejeição por regra de negócio | `422` (corpo = resultado com `failureCode`; replay também é 422) |
| aceite com processamento pendente | `202` |
| processada / replay de processada | `201` / `200` |
| falha transitória de infraestrutura | `503` + `Retry-After` (reenviar com a mesma key) |
| bug | `500` |

`404` versus `422 WALLET_NOT_FOUND`: `404` só para o recurso endereçado na URL. Uma wallet citada no corpo de um comando é dado de negócio do comando.

**Autenticação: não implementada, por decisão de timebox** (não pontua e não deve competir com correção financeira). Ponto de extensão explícito: `ProviderIdentityPort` + `ProviderAuthGuard` aplicado aos controllers de wallet/wagering, com o adaptador `NoopProviderIdentity`. Desenho que eu adotaria: Keycloak (ou Zitadel) com **OAuth2 client credentials, um client por provedor de jogos**; o guard valida o JWT pelo JWKS do IdP (`iss`, `aud`, `exp`) e lê um claim `provider_id`; `assertProviderAllowed` (já chamado nos controllers) recusa com `403` quando `body.providerId` não pertence ao principal. Health e métricas ficam abertos; mensagens da fila são canal interno confiável, mas o `providerId` da mensagem passa pelas mesmas validações de domínio.

## 13. Processamento por SQS

- **Mesmo use case** do HTTP (`ProcessWagerTransactionUseCase`), com contexto `inbox`.
- **Inbox persistente** `(consumer_name, message_id)`: `INSERT … ON CONFLICT DO NOTHING` na **mesma transação** do efeito financeiro. Duas entregas simultâneas da mesma mensagem: a segunda bloqueia na PK até a primeira comitar e então vira "duplicada" (testado com 50 entregas paralelas). Se a primeira der rollback, a segunda processa.
- **Ack (DeleteMessage) só depois do commit.** Processo morto entre commit e ack → redelivery → inbox absorve (testado matando um processo filho com `SIGKILL` logo após o commit).
- **Classificação** (`WagerMessageHandler`, independente de transporte e testada contra Postgres real):
  - sucesso, duplicata, rejeição de negócio, conflito de idempotência, wallet inexistente → **ack** (terminal);
  - mensagem malformada/payload inválido → **DLQ imediata** (permanente);
  - transitório (banco fora, lock timeout, deadlock, corrida de unique, CAS) → **retry** via `ChangeMessageVisibility` com backoff `base·2^(n-1)` (teto 15 min) usando `ApproximateReceiveCount`;
  - após `SQS_MAX_RECEIVE_COUNT` entregas → **DLQ** com atributo `deadLetterReason`. A `RedrivePolicy` da fila (`maxReceiveCount + 1`) é só rede de segurança para crash loops.
- **FIFO:** ordem por `MessageGroupId` é respeitada (lote processado sequencialmente; paralelismo vem de N pollers e N instâncias). Ordenação/deduplicação do broker são **otimização**: a correção não depende delas.
- **SIGTERM:** para de fazer polling (abort do long-poll), devolve visibilidade 0 às mensagens recebidas e ainda não iniciadas, espera as em andamento até `SHUTDOWN_GRACE_MS`; só então o pool do banco fecha (`beforeApplicationShutdown` → `onApplicationShutdown`).

## 14. Transactional Outbox

- Transação, saldo, ledger, inbox e eventos são gravados **na mesma transação SQL**. Nenhum evento é publicado antes do commit (o relay só enxerga linhas comitadas).
- **Relay** (N instâncias): (1) claim curto com `FOR UPDATE SKIP LOCKED` gravando `locked_by/locked_until` (lease) e comitando; (2) publica fora de transação; (3) grava o resultado **só se ainda for dono do lease**. Falha ao publicar → `scheduleRetry` (backoff exponencial, `attempts`, `last_error`).
- **Cenário exigido** (commit → processo morre antes de publicar → outra instância assume → publica → duplicata segura): o lease expira e outra instância publica; a instância antiga, se voltar, não consegue sobrescrever (`saveAttempt` retorna `false`). Testado.
- Entrega **at-least-once**: `eventId` = id da linha da outbox; SQS FIFO deduplica por `MessageDeduplicationId = eventId` na janela de 5 min; fora dela, consumidores deduplicam por `eventId` (contrato documentado). Sem duplicação indefinida: depois de publicado, o trigger impede reabrir.
- Envelope: classe abstrata `IntegrationEvent<T>` com uma subclasse por evento (`eventType` e `version` no tipo), `data` sempre com `MoneyProps` (strings). `aggregateId` = `walletId` em todos, para ordenação por wallet.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive LOSS |
| `WagerTransactionRejected` | rejeição por regra de negócio (inclusive `REFERENCE_NOT_FOUND`) |
| `WalletBalanceChanged` | só quando o saldo muda (inclusive OPENING) |
| `WagerTransactionPendingReference` | transição para `PENDING_REFERENCE` (não a cada retry) |

## 15. Observabilidade

- **Logs JSON** (uma linha por evento) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` vindos de um `AsyncLocalStorage` (preenchido pelo middleware HTTP e pelo handler SQS). Chaves sensíveis (`payload`, `body`, `data`, `money`, `balance`, `authorization`…) são substituídas por `[redacted]`; não se loga payload financeiro.
- **Métricas Prometheus** (`/metrics`): `wagering_transactions_total{status,kind,source}`, `wagering_duplicates_detected_total{kind}`, `wagering_retries_total{reason}`, `wagering_sqs_dead_lettered_total{reason}`, `wagering_lock_conflicts_total`, `wagering_outbox_pending`, `wagering_outbox_lag_seconds`, `wagering_outbox_published_total`, `wagering_processing_duration_seconds{source}`, `wagering_reconciliation_divergences_total`, mais as métricas padrão do processo.
- **Health:** `/health/live` (só o processo; queda do banco não deve reiniciar o pod) e `/health/ready` (PostgreSQL e SQS alcançáveis, com timeout; `503` caso contrário).
- **Reconciliação:** saldo armazenado e saldo derivado do ledger lidos **num único statement** (mesmo snapshot), mais a cabeça da cadeia (`balance_after`/`wallet_version` da última entrada). Divergência: log `error`, métrica e `consistent: false`. Nada é corrigido silenciosamente.

## 16. Testes

| Suíte | O que prova |
|---|---|
| `unit/` | Money (escala, entradas inválidas, exatidão, moeda), invariantes da Wallet, regras de BET/WIN/LOSS/REFUND/ROLLBACK, máquina de estados, hash de payload, conflito de payload, outbox/inbox |
| `integration/schema` | cada constraint/trigger da seção 7, atacando as tabelas direto; migration `down`/`up` |
| `integration/wagering-flow` | fluxos completos, replay com saldo da época, conflitos, reversões, fora de ordem + worker, inbox, **atomicidade** (falha após as escritas → nada persiste), paginação, reconciliação que sinaliza divergência |
| `integration/outbox` | publishers concorrentes, crash entre claim e publish, lease perdido, retry com backoff |
| `integration/message-handler` | ack/retry/DLQ, inclusive com PostgreSQL **realmente inalcançável** |
| `concurrency/` | cenário obrigatório, 50× a mesma aposta, 50× a mesma mensagem, wallet quente, wallets em paralelo, REFUND × ROLLBACK simultâneos, ROLLBACK antes da BET, **4 processos do SO**, worker morto após commit e antes do ack, restart com verificação global |
| `sqs/` | ponta a ponta com LocalStack: ack após commit, redelivery, DLQ permanente, retry→DLQ, publicação da outbox |

Invariante final verificado nos testes: `wallet.balance == saldo reconstruído pelo ledger`.

## 17. Teste de carga

`bun run test:load` (com a stack de pé: `docker compose up -d`) exercita a **API HTTP real**, com os workers publicando a outbox, e grava `load-test-report.md` com ambiente, metodologia e resultados.

- **Modelo fechado:** `CONCURRENCY` clientes (padrão 50) durante `DURATION_S` (30s); cada um envia a próxima requisição assim que recebe a resposta.
- **Carga realista:** 200 wallets; 20% das requisições numa **wallet quente** (contenção de lock); 5% reenviam uma requisição já enviada (replay idempotente); mix 70% BET, 25% WIN, 5% LOSS.
- **Medido:** throughput, latência p50/p95/p99/máx, distribuição de status, taxa de erro, replays, conflitos de lock e retries (via `/metrics`), backlog e lag da outbox (amostrados no PostgreSQL a cada 500 ms), tempo para drenar a outbox e **reconciliação de todas as wallets ao final**.
- **Critério de aprovação é correção, não RPS:** zero wallets inconsistentes e zero saldos negativos (o script sai com código 1 caso contrário).
- **Honestidade da medição:** o gerador de carga roda na mesma máquina que o serviço, então os números incluem a disputa de CPU entre os dois; a wallet quente serializa de propósito e domina o p99. Os 422 esperados (a wallet quente fica sem saldo) são resultado de negócio, não erro.

Os números variam com o hardware; o relatório gerado é a fonte. Para comparar configurações: `CONCURRENCY=100 HOT_SHARE=0.5 bun run test:load`.

## 18. Trade-offs e limitações

- **UoW do MikroORM não usado para escrita** (seção 4): SQL explícito em troca de identity map/dirty checking.
- **Serialização por wallet:** throughput de uma wallet quente é limitado pela latência de uma transação curta. É o preço de correção sem tempestade de retries; wallets distintas escalam horizontalmente.
- **Triggers de consistência** custam alguns lookups por indexação a cada escrita. Em troca, a consistência saldo↔ledger é garantida no commit, não por convenção.
- **Reversão parcial** fora de escopo (o valor precisa ser igual ao da referência).
- **Ledger de partidas dobradas** não implementado (diferencial opcional): há um lançamento por wallet; a contrapartida (house/provider) seria o próximo passo.
- **Consumidores dos eventos** precisam deduplicar por `eventId` fora da janela de 5 min do FIFO.
- **Autenticação** não implementada (seção 12).
- **`WALLET_NOT_FOUND`** não fica auditado como transação (limitação da FK); fica nos logs e métricas.
- Próximos passos: OpenTelemetry (traces), particionamento da outbox por data, arquivamento da tabela de inbox (TTL), double-entry, DLQ redrive tooling.
