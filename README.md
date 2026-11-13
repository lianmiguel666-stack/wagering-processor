# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`) vindas de múltiplos provedores, via HTTP e SQS, mantendo correção sob duplicação, reordenação, concorrência entre instâncias e falhas.

**Stack:** Bun 1.x · TypeScript estrito · NestJS 10 · MikroORM 6 (PostgreSQL) · AWS SQS (LocalStack) · Docker Compose · Prometheus.

As decisões técnicas, trade-offs e limitações estão em **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## Subir tudo com Docker Compose

```bash
docker compose up --build
```

Sobe: `postgres` (com o banco `wagering_test` para testes), `localstack` (filas criadas no boot), `migrate` (aplica migrations e sai), `api` (porta 3000) e **3 réplicas de `worker`** (consumidor SQS, relay da outbox e resolvedor de referências pendentes).

```bash
curl localhost:3000/health/ready      # {"status":"ok","checks":[postgres up, sqs up]}
curl localhost:3000/metrics           # métricas Prometheus
```

## Desenvolvimento local

```bash
bun install
docker compose up -d postgres localstack
cp .env.example .env
bun run migrate:up
bun run start            # APP_ROLE=all: API + workers no mesmo processo
```

| Comando | O que faz |
|---|---|
| `bun run start` / `start:api` / `start:worker` | sobe o serviço (papel via `APP_ROLE`) |
| `bun run migrate:up` / `migrate:down` / `migrate:status` | migrations versionadas e reversíveis (MikroORM Migrator) |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |
| `bun test` | todas as suítes |
| `bun run test:unit` | domínio e regras (sem I/O) |
| `bun run test:integration` | PostgreSQL real: schema, fluxos, outbox, handler de mensagens |
| `bun run test:concurrency` | paralelismo real, múltiplos processos, crash recovery |
| `bun run test:sqs` | ponta a ponta com LocalStack + PostgreSQL |
| `bun run test:load` | teste de carga contra a API rodando (gera `load-test-report.md`; ver ARCHITECTURE.md §17) |
| `bun run send:message -- --wallet <id> --player <id> --kind BET --amount 25.00 [--times 3]` | publica uma mensagem na fila (`--times` reenvia o mesmo `messageId`) |

### Testes

Os testes de integração/concorrência **não usam mocks de banco nem de fila**: precisam de `docker compose up -d postgres localstack`.

```bash
docker compose up -d postgres localstack
bun test --timeout 120000
```

- `TEST_DATABASE_URL` (padrão `postgres://wagering:wagering@localhost:5432/wagering_test`).
- `TEST_DB_DRIVER=mikro-orm` (padrão, o mesmo adaptador de produção) ou `bun-sql` (cliente nativo do Bun executando **os mesmos repositórios**, útil para rodar as suítes de banco sem dependências do ORM).
- Cada arquivo recria o schema a partir do SQL da migration.
- Todo teste que movimenta saldo termina verificando `wallet.balance == saldo reconstruído pelo ledger` (`assertLedgerConsistent`).

## API

Autenticação: ver ARCHITECTURE.md §12 (ponto de extensão `ProviderIdentityPort`, adaptador no-op). Endpoints de health e métricas são abertos. Todas as respostas carregam `X-Correlation-Id` (aceito na requisição ou gerado).

### Criar wallet

```bash
curl -s -XPOST localhost:3000/wallets -H 'content-type: application/json' -d '{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}'
# 201 {"id":"…","playerId":"…","balance":{"amount":"1000.00","currency":"BRL"},"version":1}
# 409 WALLET_ALREADY_EXISTS para o mesmo playerId + currency
```

### Submeter transação

```bash
curl -si -XPOST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' -d '{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "<walletId>",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}'
# 201 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

`REFUND`/`ROLLBACK` exigem `"referenceExternalTransactionId"`; `WIN`/`LOSS` podem referenciar a `BET` da rodada.

| Status | Significado | Pode reenviar? |
|---|---|---|
| `201` | processada agora | — |
| `200` | replay idempotente (`idempotentReplay: true`, mesmo resultado e saldo da época) | — |
| `202` | aceita, `PENDING_REFERENCE` (aguardando a referência) | consultar `GET /wagering/transactions/:id` |
| `400 VALIDATION_ERROR` | payload inválido | não, corrigir |
| `409 IDEMPOTENCY_KEY_CONFLICT` / `DUPLICATE_EXTERNAL_TRANSACTION_ID` | chave/identidade reutilizada com outro payload | não |
| `422` + `failureCode` | rejeição por regra de negócio (terminal; replay devolve o mesmo 422) | não |
| `422 WALLET_NOT_FOUND` | wallet do corpo não existe | não |
| `503 INFRASTRUCTURE_UNAVAILABLE` (+ `Retry-After`) | falha transitória | **sim, com a mesma Idempotency-Key** |

### Consultas e reconciliação

```
GET  /wallets/:walletId
GET  /wallets/:walletId/ledger?cursor=…&limit=50
GET  /wagering/transactions/:transactionId
GET  /providers/:providerId/wagering/transactions/:externalTransactionId
POST /wallets/:walletId/reconciliation
GET  /health/live · /health/ready · /metrics
```

### Mensagem SQS (`wager-transactions.fifo`)

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "transaction-123",
            "idempotencyKey": "provider-a:transaction-123", "playerId": "…", "walletId": "…",
            "roundId": "round-987", "gameId": "fortune-chimp", "kind": "BET",
            "money": { "amount": "25.00", "currency": "BRL" } }
}
```

Eventos de integração são publicados em `wagering-events.fifo` (`MessageGroupId = walletId`, `MessageDeduplicationId = eventId`).

## Estrutura

```
src/
  domain/            Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/Outbox, eventos, WagerSettlement
  application/       portas, use cases (HTTP e SQS usam o mesmo), WagerProcessor, payload hash
  infrastructure/
    persistence/     migrations (SQL), repositórios SQL, UnitOfWork, adaptador MikroORM
    messaging/       handler de mensagens (ack/retry/DLQ), consumidor e publisher SQS
    http/            controllers, mapeamento de erros, guard de autenticação, correlation id
    observability/   logger JSON com contexto assíncrono, métricas Prometheus
    workers/         relay da outbox, resolvedor de PENDING_REFERENCE
test/
  unit/ integration/ concurrency/ sqs/ support/
```
