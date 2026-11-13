import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { RequestContext } from "../observability/request-context";

const HEADER = "x-correlation-id";
const VALID = /^[A-Za-z0-9._:\-]{1,128}$/;

/** Accepts X-Correlation-Id (or creates one) and runs the request inside the async log context. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(HEADER);
  const correlationId = incoming && VALID.test(incoming) ? incoming : randomUUID();
  res.setHeader(HEADER, correlationId);
  RequestContext.run({ correlationId }, () => next());
}

export function currentCorrelationId(): string {
  return RequestContext.current()?.correlationId ?? randomUUID();
}
