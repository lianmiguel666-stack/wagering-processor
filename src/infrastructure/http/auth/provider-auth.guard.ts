import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { TOKENS } from "../../tokens";

/**
 * Who is calling. In production this would come from a JWT issued by an
 * external IdP (Keycloak/Zitadel, OAuth2 client-credentials, one client per
 * game provider). See ARCHITECTURE.md §Authentication.
 */
export interface ProviderPrincipal {
  subject: string;
  /** Providers this caller may act for; "*" = any (no-op / back-office). */
  providerIds: readonly string[] | "*";
}

/** Extension point: plug a real IdP adapter here. */
export interface ProviderIdentityPort {
  authenticate(request: Request): Promise<ProviderPrincipal | null>;
}

/**
 * Default adapter: authentication is intentionally NOT implemented in this
 * challenge (it scores no points and must not compete with financial
 * correctness). Every caller is treated as a trusted internal principal.
 *
 * Replace with e.g. `OidcProviderIdentity` that validates the bearer token
 * against the IdP JWKS (iss, aud, exp) and maps a `provider_id` claim.
 */
export class NoopProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<ProviderPrincipal> {
    return { subject: "anonymous-internal", providerIds: "*" };
  }
}

export const PRINCIPAL_KEY = "principal";

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(TOKENS.ProviderIdentity) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { [PRINCIPAL_KEY]?: ProviderPrincipal }>();
    const principal = await this.identity.authenticate(request);
    if (!principal) throw new UnauthorizedException();
    request[PRINCIPAL_KEY] = principal;
    return true;
  }
}

/** The provider in the body must be one the principal may act for (same domain validation as the queue). */
export function assertProviderAllowed(principal: ProviderPrincipal | undefined, providerId: unknown): void {
  if (!principal || principal.providerIds === "*") return;
  if (typeof providerId !== "string" || !principal.providerIds.includes(providerId)) {
    throw new ForbiddenException(`principal ${principal.subject} cannot act for provider ${String(providerId)}`);
  }
}
