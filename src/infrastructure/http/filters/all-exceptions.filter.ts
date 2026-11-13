import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from "@nestjs/common";
import type { Response } from "express";
import type { AppLogger } from "../../../application/ports/runtime";
import { RequestErrorCode } from "../../../domain/wagering/failure-code";
import { TOKENS } from "../../tokens";
import { mapError } from "./error-mapping";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(TOKENS.Logger) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      // Framework-level errors (malformed JSON, guard rejections...).
      const status = exception.getStatus();
      const code =
        status === 400
          ? RequestErrorCode.ValidationError
          : status === 401 || status === 403
            ? RequestErrorCode.Unauthorized
            : status === 404
              ? RequestErrorCode.NotFound
              : RequestErrorCode.InternalError;
      response.status(status).json({ error: { code, message: exception.message, retryable: false } });
      return;
    }

    const mapped = mapError(exception);
    if (mapped.status >= 500) {
      this.logger.error("request failed", { status: mapped.status, err: String(exception) });
    } else {
      this.logger.info("request refused", { status: mapped.status, code: mapped.body.error.code });
    }
    if (mapped.retryAfterSeconds) response.setHeader("Retry-After", String(mapped.retryAfterSeconds));
    response.status(mapped.status).json(mapped.body);
  }
}
