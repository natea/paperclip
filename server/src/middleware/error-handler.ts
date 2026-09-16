import type { Request, Response, NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { captureException } from "../sentry.js";
import { COMPANY_IMPORT_API_PATH } from "../routes/company-import-paths.js";
import { logger } from "./logger.js";
import {
  recordResponsibleUserDenialOnActiveRun,
} from "../services/responsible-user-denial-run-outcomes.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function isRedactedSkillPolicyDenial(details: Record<string, unknown> | null) {
  return details?.code === "skill_policy_denied";
}

function readZodIssues(err: unknown): unknown[] | null {
  if (err instanceof ZodError) return err.issues;
  if (!err || typeof err !== "object" || (err as { name?: unknown }).name !== "ZodError") return null;
  const issues = (err as { issues?: unknown }).issues;
  return Array.isArray(issues) ? issues : null;
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

/** Report a server-side crash to every error sink. */
function reportCrash(error: Error): void {
  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: error.name });
  captureException(error);
}

function getPaperclipDb(req: Request): Db | null {
  const locals = req.app?.locals as { paperclipDb?: Db; db?: Db } | undefined;
  return locals?.paperclipDb ?? locals?.db ?? null;
}

function recordResponsibleUserDenialFromHttpError(
  req: Request,
  details: Record<string, unknown> | null,
) {
  if (req.actor?.type !== "agent") return;
  const db = getPaperclipDb(req);
  if (!db) return;

  void recordResponsibleUserDenialOnActiveRun(db, {
    runId: req.actor.runId ?? null,
    agentId: req.actor.agentId ?? null,
    companyId: req.actor.companyId ?? null,
    code: details?.code,
  }).catch((recordErr) => {
    logger.warn(
      {
        err: recordErr,
        runId: req.actor?.runId ?? null,
        agentId: req.actor?.type === "agent" ? req.actor.agentId ?? null : null,
      },
      "failed to record responsible-user denial on heartbeat run",
    );
  });
}

/**
 * AND-14: body-parser rejects a request before any route runs, and its errors
 * are plain `SyntaxError`s that fell through to the generic 500 branch. A
 * caller then cannot tell "your body is not JSON" from "the server broke", so
 * an agent that mangled its own payload retries the same mangled payload. Give
 * the failure the same three obligations every other denial carries: what
 * fired, and the path forward, behind a `code` the caller can branch on.
 */
function readBodyParserError(err: unknown): { status: number; code: string; sanctionedPath: string } | null {
  if (!err || typeof err !== "object") return null;
  const candidate = err as { type?: unknown; status?: unknown; statusCode?: unknown; body?: unknown };
  if (typeof candidate.type !== "string" || !("body" in candidate)) return null;
  const status = typeof candidate.status === "number"
    ? candidate.status
    : typeof candidate.statusCode === "number" ? candidate.statusCode : 400;
  switch (candidate.type) {
    case "entity.too.large":
      return {
        status,
        code: "request_body_too_large",
        sanctionedPath: "Split the payload — post long prose as a separate comment rather than inline — and retry.",
      };
    case "encoding.unsupported":
    case "charset.unsupported":
      return {
        status,
        code: "unsupported_request_encoding",
        sanctionedPath: "Send the body as UTF-8 JSON with `Content-Type: application/json` and retry.",
      };
    default:
      return {
        status,
        code: "malformed_request_body",
        sanctionedPath:
          "Re-encode the body as valid JSON and retry. Multi-line prose must escape its newlines " +
          "(`\\n` inside the string), so build the payload with a JSON serializer rather than by hand.",
      };
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    const details = err.details && typeof err.details === "object" && !Array.isArray(err.details)
      ? err.details as Record<string, unknown>
      : null;
    const redactedSkillPolicyDenial = isRedactedSkillPolicyDenial(details);
    const workspaceRepairPreconditionFailure = details?.code === "workspace_repair_precondition_failed";
    const structuredConnectionError = new Set([
      "user_authorization_required",
      "organization_authorization_required",
      "grant_audience_denied",
      "grant_revoked",
      "needs_reauthorization",
      "installation_required",
      "connection_not_installed",
      "subject_not_permitted",
      "standing_delegation_required",
      "grant_owner_membership_inactive",
    ]).has(typeof details?.code === "string" ? details.code : "");
    recordResponsibleUserDenialFromHttpError(req, details);
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err,
      );
      reportCrash(err);
    }
    res.status(err.status).json({
      error: err.message,
      ...(typeof details?.code === "string" ? { code: details.code } : {}),
      ...(redactedSkillPolicyDenial && typeof details?.reason === "string" ? { reason: details.reason } : {}),
      ...(workspaceRepairPreconditionFailure && typeof details?.reason === "string" ? { reason: details.reason } : {}),
      ...(workspaceRepairPreconditionFailure && typeof details?.repairPhase === "string"
        ? { repairPhase: details.repairPhase }
        : {}),
      ...(typeof details?.remediation === "string" || (structuredConnectionError && details?.remediation && typeof details.remediation === "object")
        ? { remediation: details.remediation }
        : {}),
      ...(structuredConnectionError && details?.connection ? { connection: details.connection } : {}),
      ...(structuredConnectionError && details?.subject ? { subject: details.subject } : {}),
      ...(structuredConnectionError && typeof details?.grantId === "string" ? { grantId: details.grantId } : {}),
      ...(!redactedSkillPolicyDenial && !workspaceRepairPreconditionFailure && err.details
        ? { details: err.details }
        : {}),
    });
    return;
  }

  const zodIssues = readZodIssues(err);
  if (zodIssues) {
    res.status(400).json({ error: "Validation error", details: zodIssues });
    return;
  }

  const bodyParserError = readBodyParserError(err);
  if (bodyParserError) {
    const reason = err instanceof Error ? err.message : String(err);
    res.status(bodyParserError.status).json({
      error: `Request body could not be read. ${bodyParserError.sanctionedPath}`,
      code: bodyParserError.code,
      details: {
        code: bodyParserError.code,
        reason,
        sanctionedPath: bodyParserError.sanctionedPath,
      },
    });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  reportCrash(rootError);

  res.status(500).json({
    error: "Internal server error",
    ...(shouldExposeTrustedCloudTenantImportError(req) ? { message: rootError.message } : {}),
  });
}

function shouldExposeTrustedCloudTenantImportError(req: Request) {
  return req.actor?.source === "cloud_tenant"
    && req.method === "POST"
    && req.originalUrl.split("?")[0] === COMPANY_IMPORT_API_PATH;
}
