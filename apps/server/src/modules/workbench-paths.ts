import type { FastifyRequest } from 'fastify';
export const templateBindingPath = '/api/requirements/:id/capability-template';
export const personnelPath = '/api/requirements/:id/personnel';
export const sessionsPath = '/api/requirements/:id/sessions';
export const sessionHistoryPath =
  '/api/requirements/:id/sessions/:sessionId/history';
export const sessionTemplatePath =
  '/api/requirements/:id/sessions/:sessionId/capability-template';
export const businessAuditPath = '/api/requirements/:id/business-audit';
export const projectBusinessAuditPath =
  '/api/projects/:projectId/business-audit';
export const sessionForkPath = '/api/requirements/:id/sessions/:sessionId/fork';
export const nativeBootstrapPath = '/api/dsh/:id/bootstrap';
export const nativeTransportPath = '/api/dsh/:id/native/*';
export const nativeMuxPath = '/api/dsh/:id/native/api/remote.mux';
export const nativeBindingHeader = 'x-rdws-native-login';
export const nativeGenerationHeader = 'x-rdws-client-generation';
export const importPreviewPath =
  '/api/projects/:projectId/requirements/import/preview';
export const importCommitPath =
  '/api/projects/:projectId/requirements/import/commit';
export const isImportRequest = (request: FastifyRequest) =>
  request.method === 'POST' &&
  (request.routeOptions.url === importPreviewPath ||
    request.routeOptions.url === importCommitPath);
export const isTemplateBindingRequest = (request: FastifyRequest) =>
  request.routeOptions.url === templateBindingPath &&
  (request.method === 'GET' || request.method === 'POST');
export const isPassiveRequirementRead = (request: FastifyRequest) =>
  request.method === 'GET' &&
  (request.routeOptions.url === sessionsPath ||
    request.routeOptions.url === sessionHistoryPath ||
    request.routeOptions.url === sessionTemplatePath ||
    request.routeOptions.url === businessAuditPath);
export const isProjectAuditRead = (request: FastifyRequest) =>
  request.method === 'GET' &&
  request.routeOptions.url === projectBusinessAuditPath;
export const isSessionWrite = (request: FastifyRequest) =>
  request.method === 'POST' &&
  (request.routeOptions.url === sessionsPath ||
    request.routeOptions.url === sessionForkPath);
