// HTTP surface for the HTML → Video capability.
//
// Mirrors the media capability's generate flow (see routes/media.ts) but for
// the dedicated html-video surface. Generation is accepted asynchronously and
// runs on the shared media task queue, so callers poll progress through the
// existing `POST /api/media/tasks/:id/wait` endpoint — this file deliberately
// does NOT re-implement task waiting.
//
// Two entry points, matching media:
//   POST /api/projects/:id/html-video/generate  — local UI/CLI (same-origin)
//   POST /api/tools/html-video/generate         — sandboxed agent (tool token)
// Plus a read-only catalogue:
//   GET  /api/html-video/templates

import type { Express } from 'express';
import type { MediaExecutionPolicy } from '@open-design/contracts';
import { defaultMediaExecutionPolicy, mediaPolicyDenial } from '../media/policy.js';
import { generateHtmlVideo, listHtmlVideoTemplates } from '../html-video/index.js';
import { isSandboxModeEnabled } from '../sandbox-mode.js';
import type { RouteDeps } from '../server-context.js';
import type { ToolTokenGrant } from '../tool-tokens.js';
import { resolveLegacyMediaRouteGrant } from './media.js';

export interface RegisterHtmlVideoRoutesDeps
  extends RouteDeps<'db' | 'design' | 'http' | 'paths' | 'ids' | 'auth' | 'media' | 'projectStore'> {}

export function registerHtmlVideoRoutes(app: Express, ctx: RegisterHtmlVideoRoutesDeps) {
  const { db, design } = ctx;
  const { sendApiError, isLocalSameOrigin, resolvedPortRef } = ctx.http;
  const { PROJECT_ROOT, PROJECTS_DIR, DESIGN_TEMPLATES_DIR, USER_DESIGN_TEMPLATES_DIR } = ctx.paths;
  const templateRoots = [USER_DESIGN_TEMPLATES_DIR, DESIGN_TEMPLATES_DIR].filter(Boolean);
  const { authorizeToolRequest, optionalToolGrantFromRequest, requestProjectOverride } = ctx.auth;
  const { randomUUID } = ctx.ids;
  const { createMediaTask, persistMediaTask, appendTaskProgress, notifyTaskWaiters } = ctx.media;
  const { getProject } = ctx.projectStore;
  const getResolvedPort = () => resolvedPortRef.current;

  // html-video is a 'video' surface; reuse the run-scoped media policy so a
  // run that disabled media generation can't be bypassed through this route.
  const policyForGrant = (grant: ToolTokenGrant | null):
    | { ok: true; policy: MediaExecutionPolicy }
    | { ok: false; code: string; message: string } => {
    if (!grant?.runId) return { ok: true, policy: defaultMediaExecutionPolicy() };
    const run = design.runs.get(grant.runId);
    if (!run) {
      return {
        ok: false,
        code: 'MEDIA_POLICY_UNAVAILABLE',
        message: 'media generation policy is unavailable for this run',
      };
    }
    return { ok: true, policy: run.mediaExecution ?? defaultMediaExecutionPolicy() };
  };

  const handleGenerate = async (
    req: any,
    res: any,
    options: { projectId: string; grant: ToolTokenGrant | null },
  ) => {
    const projectId = options.projectId;
    const project = getProject(db, projectId);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const compositionDir =
      typeof req.body?.compositionDir === 'string' ? req.body.compositionDir : undefined;
    const template = typeof req.body?.template === 'string' ? req.body.template : undefined;
    if (!compositionDir && !template) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'compositionDir or template is required');
    }
    const inputs: Record<string, string> = {};
    if (req.body?.inputs && typeof req.body.inputs === 'object' && !Array.isArray(req.body.inputs)) {
      for (const [key, val] of Object.entries(req.body.inputs as Record<string, unknown>)) {
        if (typeof val === 'string') inputs[key] = val;
      }
    }

    const policy = policyForGrant(options.grant);
    if (!policy.ok) {
      return sendApiError(res, 403, policy.code, policy.message);
    }
    const denial = mediaPolicyDenial(policy.policy, { surface: 'video', model: 'hyperframes-html' });
    if (denial) {
      return sendApiError(res, 403, denial.code, denial.message);
    }

    let task: ReturnType<typeof createMediaTask> | null = null;
    try {
      const taskId = randomUUID();
      task = createMediaTask(taskId, projectId, { surface: 'video', model: 'html-video' });
      task.status = 'running';
      persistMediaTask(task);
      generateHtmlVideo({
        projectRoot: PROJECT_ROOT,
        projectsRoot: PROJECTS_DIR,
        projectId,
        compositionDir,
        template,
        inputs,
        templateRoots,
        output: typeof req.body?.output === 'string' ? req.body.output : undefined,
        aspect: typeof req.body?.aspect === 'string' ? req.body.aspect : undefined,
        onProgress: (line: string) => appendTaskProgress(task!, line),
      })
        .then((meta) => {
          task!.status = 'done';
          task!.file = meta;
          task!.endedAt = Date.now();
          persistMediaTask(task!);
          notifyTaskWaiters(task!);
        })
        .catch((err: any) => {
          task!.status = 'failed';
          task!.error = {
            message: String(err && err.message ? err.message : err),
            status: typeof err?.status === 'number' ? err.status : 400,
            code: err?.code,
          };
          task!.endedAt = Date.now();
          persistMediaTask(task!);
          notifyTaskWaiters(task!);
        });

      return res.status(202).json({
        taskId,
        status: task.status,
        startedAt: task.startedAt,
      });
    } catch (err: any) {
      if (task) {
        task.status = 'failed';
        task.error = {
          message: String(err && err.message ? err.message : err),
          status: typeof err?.status === 'number' ? err.status : 400,
          code: err?.code,
        };
        task.endedAt = Date.now();
        persistMediaTask(task);
        notifyTaskWaiters(task);
      }
      throw err;
    }
  };

  app.get('/api/html-video/templates', (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    res.json({ templates: listHtmlVideoTemplates(templateRoots, search) });
  });

  app.post('/api/projects/:id/html-video/generate', async (req, res) => {
    if (!isLocalSameOrigin(req, getResolvedPort())) {
      return res.status(403).json({
        error:
          'cross-origin request rejected: html-video generation is restricted to the local UI / CLI',
      });
    }
    try {
      const grant = optionalToolGrantFromRequest(req, { operation: 'media:generate' });
      const grantDecision = resolveLegacyMediaRouteGrant({
        grant,
        projectId: req.params.id,
        requestProjectOverride,
        sandboxMode: isSandboxModeEnabled(process.env),
      });
      if (!grantDecision.ok) {
        return sendApiError(
          res,
          grantDecision.status,
          grantDecision.code,
          grantDecision.message,
          grantDecision.details ? { details: grantDecision.details } : {},
        );
      }
      await handleGenerate(req, res, { projectId: req.params.id, grant: grantDecision.grant });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      const code = err?.code;
      const body: any = { error: String(err && err.message ? err.message : err) };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  });

  app.post('/api/tools/html-video/generate', async (req, res) => {
    const grant = authorizeToolRequest(req, res, 'media:generate');
    if (!grant) return;
    try {
      await handleGenerate(req, res, { projectId: grant.projectId, grant });
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      const code = err?.code;
      const body: any = { error: String(err && err.message ? err.message : err) };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  });
}
