import { randomUUID } from 'node:crypto';
import { AttachmentError, storeAttachment } from './attachment-service.js';

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function validId(id) {
  if (typeof id !== 'string' || !uuidPattern.test(id)) throw new AttachmentError('Invalid upload identifier.');
  return id.toLowerCase();
}

// A client-generated request id lets removal cancel an upload even when its
// response (and server-generated filename) has not reached the browser yet.
export class AttachmentUploadStore {
  constructor(lifecycle) { this.lifecycle = lifecycle; this.requests = new Map(); }
  prune() {
    for (const [id, request] of this.requests) if ((request.cancelled || request.fileId) && Date.now() - request.updatedAt > 3600000) this.requests.delete(id);
  }
  begin(requestId = randomUUID()) {
    this.prune();
    const id = validId(requestId);
    if (this.requests.has(id)) throw new AttachmentError('Upload cancelled or already submitted.', 409);
    const request = { id, cancelled: false, fileId: null, updatedAt: Date.now() };
    this.requests.set(id, request); return request;
  }
  store(request, bytes, options) {
    if (request.cancelled) throw new AttachmentError('Upload cancelled.', 409);
    const file = storeAttachment(bytes, { ...options, directory: this.lifecycle.directory });
    request.fileId = file.id; request.updatedAt = Date.now();
    return { ...file, uploadId: request.id };
  }
  async discard({ id, uploadId } = {}) {
    if (!id && !uploadId) throw new AttachmentError('An upload identifier is required.');
    const fileId = id ? validId(id) : null, requestId = uploadId ? validId(uploadId) : null;
    this.prune();
    let request = requestId && this.requests.get(requestId);
    if (request?.fileId && fileId && request.fileId !== fileId) throw new AttachmentError('Upload identifiers do not match.');
    if (requestId) {
      if (!request) { request = { id: requestId, fileId: null }; this.requests.set(requestId, request); }
      request.cancelled = true; request.updatedAt = Date.now();
    }
    const ids = new Set([fileId, request?.fileId].filter(Boolean));
    if (!ids.size) return { deleted: 0, retained: 0, warning: false };
    const files = this.lifecycle.files().filter(file => ids.has(file.id));
    return this.lifecycle.cleanupDeleted({ threadIds: [], files });
  }
}
