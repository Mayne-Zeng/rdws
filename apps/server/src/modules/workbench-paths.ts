import type { FastifyRequest } from 'fastify';
export const templateBindingPath = '/api/requirements/:id/capability-template';
export const personnelPath = '/api/requirements/:id/personnel';
export const sessionsPath = '/api/requirements/:id/sessions';
export const writeAuthorityStatusPath = '/api/requirements/:id/write-authority';
export const writeAuthorityCommandPath =
  '/api/requirements/:id/sessions/:sessionId/write-authority/commands';
export const writeAuthorityCheckPath =
  '/api/requirements/:id/sessions/:sessionId/write-authority/check';
export const sessionHistoryPath =
  '/api/requirements/:id/sessions/:sessionId/history';
export const sessionAnchorsPath =
  '/api/requirements/:id/sessions/:sessionId/anchors';
export const sessionExecutionPath =
  '/api/requirements/:id/sessions/:sessionId/execution';
export const sessionTemplatePath =
  '/api/requirements/:id/sessions/:sessionId/capability-template';
export const businessAuditPath = '/api/requirements/:id/business-audit';
export const projectBusinessAuditPath =
  '/api/projects/:projectId/business-audit';
export const crossProjectBusinessAuditPath = '/api/audit/business';
export const projectAccessAuditPath = '/api/projects/:projectId/access-audit';
export const platformAccountAuditPath =
  '/api/management/platform/account-audit';
export const sessionForkPath = '/api/requirements/:id/sessions/:sessionId/fork';
export const sessionModelSelectionPath =
  '/api/requirements/:id/sessions/:sessionId/model-selection';
export const promptReceiptPath =
  '/api/requirements/:id/sessions/:sessionId/prompt-receipt';
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
    request.routeOptions.url === sessionAnchorsPath ||
    request.routeOptions.url === sessionExecutionPath ||
    request.routeOptions.url === sessionTemplatePath ||
    request.routeOptions.url === businessAuditPath);
export const isWriteAuthorityStatus = (request: FastifyRequest) =>
  request.method === 'GET' &&
  request.routeOptions.url === writeAuthorityStatusPath;
export const isWriteAuthorityCommand = (request: FastifyRequest) =>
  request.method === 'POST' &&
  (request.routeOptions.url === writeAuthorityCommandPath ||
    request.routeOptions.url === writeAuthorityCheckPath);
export const isProjectAuditRead = (request: FastifyRequest) =>
  request.method === 'GET' &&
  request.routeOptions.url === projectBusinessAuditPath;
export const isCrossProjectAuditRead = (request: FastifyRequest) =>
  request.method === 'GET' &&
  request.routeOptions.url === crossProjectBusinessAuditPath;
export const isProjectAccessAuditRead = (request: FastifyRequest) =>
  request.method === 'GET' &&
  request.routeOptions.url === projectAccessAuditPath;
export const isPlatformAccountAuditRead = (request: FastifyRequest) =>
  request.method === 'GET' &&
  request.routeOptions.url === platformAccountAuditPath;
export const isSessionWrite = (request: FastifyRequest) =>
  request.method === 'POST' &&
  (request.routeOptions.url === sessionsPath ||
    request.routeOptions.url === sessionForkPath);
export const isModelSelectionRequest = (request: FastifyRequest) =>
  (request.routeOptions.url === sessionModelSelectionPath &&
    (request.method === 'GET' || request.method === 'POST')) ||
  (request.routeOptions.url === promptReceiptPath && request.method === 'POST');
