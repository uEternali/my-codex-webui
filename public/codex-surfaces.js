export const CODEX_MOTION = Object.freeze({
  shimmer: Object.freeze({ durationMs: 2000, steps: 48, from: "-100%", to: "250%" }),
  approvalEnter: null,
  accordion: Object.freeze({ durationMs: 300, easing: "cubic-bezier(.19,1,.22,1)" }),
});

const hasDecision = (available, name) => !Array.isArray(available) || available.some((decision) => {
  if (typeof decision === "string") return decision === name;
  return decision && typeof decision === "object" && name in decision;
});

export function buildApprovalModel(request) {
  const method = request.method;
  const params = request.params || {};
  const available = params.availableDecisions;
  const base = {
    reason: params.reason || null,
    cwd: params.cwd || null,
    command: params.command || null,
    primary: { label: "Allow once", decision: "accept" },
    deny: { label: "Deny", decision: "decline" },
    cancel: null,
    leading: null,
    scoped: null,
  };

  if (method === "item/commandExecution/requestApproval") {
    let scoped = hasDecision(available, "acceptForSession")
      ? { label: "Allow this conversation", decision: "acceptForSession" }
      : null;
    if (params.proposedExecpolicyAmendment?.length && params.proposedExecpolicyAmendment.every((line) => !/[\r\n]/.test(line))) {
      scoped = {
        label: "Allow similar commands",
        decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } },
      };
    }
    const network = params.networkApprovalContext;
    if (params.proposedNetworkPolicyAmendments?.length && hasDecision(available, "applyNetworkPolicyAmendment")) {
      const amendment = params.proposedNetworkPolicyAmendments.find((entry) => entry.action === "allow") || params.proposedNetworkPolicyAmendments[0];
      const leading = {
        label: amendment?.host ? `Always allow ${amendment.host}` : "Always allow",
        decision: { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } },
      };
      return {
        ...base,
        kind: "network",
        identity: "Internet access",
        title: `Allow ChatGPT to connect to ${network?.host || amendment?.host || "the internet"}?`,
        subtitle: `${network?.host || amendment?.host} isn't on the current network allowlist`,
        scoped: hasDecision(available, "acceptForSession") ? { label: "Allow this conversation", decision: "acceptForSession" } : null,
        leading,
      };
    }
    return {
      ...base,
      kind: network ? "network" : "exec",
      identity: network ? "Internet access" : "Terminal",
      title: network ? `Allow ChatGPT to connect to ${network.host || "the internet"}?` : "Allow ChatGPT to run this command?",
      subtitle: network?.host ? `${network.host} isn't on the current network allowlist` : params.cwd || null,
      scoped,
    };
  }

  if (method === "item/fileChange/requestApproval") {
    return {
      ...base,
      kind: "patch",
      identity: "Edit files",
      title: `Allow ChatGPT to edit the following ${params.fileCount === 1 ? "file" : "files"}?`,
      subtitle: params.grantRoot || null,
      scoped: hasDecision(available, "acceptForSession")
        ? { label: "Allow all edits", decision: "acceptForSession" }
        : null,
    };
  }

  if (method === "item/permissions/requestApproval") {
    const permissions = params.permissions || {};
    const rows = permissionRows(permissions);
    const network = permissions.network?.enabled;
    const reads = rows.filter((row) => row.label === "Read").map((row) => row.value);
    const writes = rows.filter((row) => row.label === "Write").map((row) => row.value);
    const paths = [...new Set([...reads, ...writes])].join(", ");
    let action = network ? "connect to the internet" : "";
    const fileAction = reads.length && writes.length ? `view and edit the contents of ${paths}` : writes.length ? `edit the contents of ${paths}` : reads.length ? `view the contents of ${paths}` : "";
    if (action && fileAction) action += ` and ${fileAction}`; else action ||= fileAction || "use additional permissions";
    const decision = (scope) => ({ permissions, scope, strictAutoReview: false });
    return {
      ...base,
      kind: "permission",
      identity: network && !fileAction ? "Internet access" : "Permissions",
      title: `Allow ChatGPT to ${action}?`,
      subtitle: params.reason || null,
      reason: null,
      primary: { label: "Allow once", decision: decision("turn") },
      scoped: { label: "Allow this conversation", decision: decision("session") },
      deny: { label: "Deny", decision: { permissions: {}, scope: "turn" } },
      cancel: null,
      permissions,
    };
  }

  throw new Error(`Unsupported approval request: ${method}`);
}

function cleanDiffPath(value = "") {
  let path = value.replace(/\t.*$/, "");
  if (path.startsWith('"') && path.endsWith('"')) {
    // Git quotes UTF-8 paths with octal bytes, rather than JSON Unicode escapes.
    const bytes = [];
    for (const token of path.slice(1, -1).match(/\\[0-7]{1,3}|\\.|[^\\]+/g) || []) {
      if (/^\\[0-7]/.test(token)) bytes.push(parseInt(token.slice(1), 8));
      else bytes.push(...new TextEncoder().encode(token.startsWith('\\') ? ({ n: '\n', t: '\t', r: '\r' }[token[1]] || token[1]) : token));
    }
    path = new TextDecoder().decode(new Uint8Array(bytes));
  }
  return path.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(diff = "") {
  const files = [];
  let file = null;
  let hunk = null;
  let linesAdded = 0;
  let linesDeleted = 0;
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  let pendingOldPath = "";
  const createFile = (path, oldPath = path) => ({ path, oldPath, kind: 'update', linesAdded: 0, linesDeleted: 0, hunks: [], metadata: [] });
  for (const raw of String(diff).replace(/\r\n/g, '\n').split("\n")) {
    const git = raw.match(/^diff --git ("(?:\\.|[^"\\])*"|a\/.+) ("(?:\\.|[^"\\])*"|b\/.+)$/);
    if (git) {
      file = createFile(cleanDiffPath(git[2]), cleanDiffPath(git[1]));
      files.push(file);
      hunk = null;
      continue;
    }
    if (hunk && oldRemaining === 0 && newRemaining === 0 && !raw.startsWith('\\ No newline')) hunk = null;
    const header = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header && file) {
      oldLine = Number(header[1]); newLine = Number(header[3]);
      oldRemaining = Number(header[2] ?? 1); newRemaining = Number(header[4] ?? 1);
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (raw.startsWith('--- ')) {
        pendingOldPath = cleanDiffPath(raw.slice(4));
        if (file?.hunks.length) file = null;
        if (file) file.oldPath = pendingOldPath;
      } else if (raw.startsWith('+++ ')) {
        const path = cleanDiffPath(raw.slice(4));
        if (!file) { file = createFile(path, pendingOldPath); files.push(file); }
        file.path = path === '/dev/null' ? file.oldPath : path;
        if (path === '/dev/null') file.kind = 'delete';
        else if (file.oldPath === '/dev/null') file.kind = 'add';
      } else if (file && /^(?:new file|deleted file|old mode|new mode|rename (?:from|to)|similarity index|Binary files|GIT binary patch)/.test(raw)) {
        file.metadata.push(raw);
        if (raw.startsWith('new file')) file.kind = 'add';
        if (raw.startsWith('deleted file')) file.kind = 'delete';
        if (raw.startsWith('rename to ')) { file.kind = 'rename'; file.path = cleanDiffPath(raw.slice(10)); }
        if (raw.startsWith('rename from ')) file.oldPath = cleanDiffPath(raw.slice(12));
        if (/^(?:Binary files|GIT binary patch)/.test(raw)) file.binary = true;
      }
      continue;
    }
    if (raw.startsWith('\\ No newline')) { hunk.lines.push({ type: 'meta', text: raw }); continue; }
    const type = raw[0] === '+' ? 'add' : raw[0] === '-' ? 'delete' : raw[0] === ' ' ? 'context' : null;
    if (!type) continue;
    const line = { type, text: raw.slice(1), oldLine: type === 'add' ? null : oldLine++, newLine: type === 'delete' ? null : newLine++ };
    if (type !== 'add') oldRemaining--;
    if (type !== 'delete') newRemaining--;
    if (type === 'add') { file.linesAdded++; linesAdded++; }
    if (type === 'delete') { file.linesDeleted++; linesDeleted++; }
    hunk.lines.push(line);
  }
  return { hasChanges: files.length > 0, fileCount: files.length, linesAdded, linesDeleted, files };
}

function fileChangeKind(change = {}) {
  return typeof change.kind === "string" ? change.kind : change.kind?.type || "update";
}

export function unifiedDiffFromFileChanges(changes = []) {
  const sections = [];
  for (const change of changes) {
    const path = String(change?.path || change?.filePath || "");
    let diff = change?.diff ?? change?.unified_diff;
    const kind = fileChangeKind(change);
    if (!path || typeof diff !== 'string' || /[\r\n]/.test(path)) continue;
    const hunkPatch = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(diff) || /^diff --git /m.test(diff);
    // Add/delete items from app-server contain the file body, not a unified patch.
    if ((kind === 'add' || kind === 'delete') && !hunkPatch) {
      const content = diff.split('\n');
      if (content.at(-1) === '') content.pop();
      const count = content.length, sign = kind === 'add' ? '+' : '-';
      const endsWithNewline = diff.endsWith('\n');
      diff = count ? `@@ -${kind === 'add' ? '0,0' : `1,${count}`} +${kind === 'delete' ? '0,0' : `1,${count}`} @@\n${content.map(line => sign + line).join('\n')}${endsWithNewline ? '' : '\n\\ No newline at end of file'}` : '';
    } else if (!diff) continue;
    if (/^diff --git /m.test(diff)) {
      sections.push(diff);
      continue;
    }
    const quote = value => /[\s"\\]/.test(value) ? JSON.stringify(value) : value;
    const oldPath = kind === "add" ? "/dev/null" : quote(`a/${path}`);
    const newPath = kind === "delete" ? "/dev/null" : quote(`b/${path}`);
    const metadata = /^--- /m.test(diff) && /^\+\+\+ /m.test(diff)
      ? diff
      : `--- ${oldPath}\n+++ ${newPath}\n${diff}`;
    sections.push(`diff --git ${quote(`a/${path}`)} ${quote(`b/${path}`)}\n${metadata}`);
  }
  return sections.map(section => section.endsWith('\n') ? section : section + '\n').join('');
}

function shellWords(command = "") {
  return String(command).match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g)?.map((word) => word.replace(/^(['"])(.*)\1$/, "$2")) || [];
}

function hasShellControl(command = "") {
  let quote = null;
  const value = String(command);
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "\\" && quote !== "'") { index++; continue; }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (quote == null) quote = char;
      continue;
    }
    if (quote !== "'" && (char === "`" || (char === "$" && value[index + 1] === "("))) return true;
    if (quote == null && (";&|<>\n\r".includes(char))) return true;
  }
  return false;
}

function explorationCommand(command = "") {
  if (hasShellControl(command)) return null;
  const words = shellWords(command);
  const name = words[0]?.split("/").at(-1);
  const hasOption = (options) => words.some((word) => options.some((option) => word === option || word.startsWith(`${option}=`)));
  if (name === "find" && hasOption(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"])) return null;
  if (name === "fd" && hasOption(["-x", "-X", "--exec", "--exec-batch"])) return null;
  if (["cat", "head", "tail", "bat", "less"].includes(name)) {
    const target = [...words.slice(1)].reverse().find((word) => !word.startsWith("-")) || "file";
    return { category: "read", detail: target, activeLabel: "Reading", completedLabel: "Read", animation: "local-context" };
  }
  if (["rg", "grep", "ag", "ack"].includes(name)) {
    const values = words.slice(1).filter((word) => !word.startsWith("-"));
    const query = values[0];
    return { category: "search", detail: query ? `for ${query}` : "files", activeLabel: "Searching", completedLabel: "Searched", animation: "searching" };
  }
  if (["ls", "find", "fd"].includes(name)) {
    const target = words.slice(1).find((word) => !word.startsWith("-")) || "files";
    return { category: "list", detail: target === "files" ? "files" : `files in ${target}`, activeLabel: "Listing", completedLabel: "Listed", animation: "local-context" };
  }
  return null;
}

export function summarizeActivity(item) {
  const status = item.status || "completed";
  const active = status === "inProgress" || status === "running" || status === "pendingInit";
  const failed = ["failed", "declined", "errored", "interrupted", "cancelled", "canceled"].includes(status);
  if (item.type === "contextCompaction") return {
    label: active ? "Compacting context…" : failed ? "Context compaction failed" : "Context compacted",
    detail: "", category: "compaction", animation: "local-context", active,
    tone: failed ? "error" : active ? "active" : "success",
  };
  if (item.type === "imageView") {
    const paths = item.imagePaths || [];
    const count = paths.length;
    return {
      label: active ? "Viewing images" : failed ? "Image view failed" : count === 1 ? "Viewed image" : "Viewed images",
      detail: count === 1 ? paths[0] : count ? `${count} images` : "",
      category: "image",
      animation: "local-context",
      active,
      tone: failed ? "error" : active ? "active" : "success",
    };
  }
  if (item.type === "commandExecution") {
    const command = item.command || (item.commandActions || []).map((action) => action?.command).filter(Boolean).join("\n");
    const exploration = explorationCommand(command);
    if (exploration && !failed) return {
      label: active ? exploration.activeLabel : exploration.completedLabel,
      detail: exploration.detail,
      category: exploration.category,
      animation: exploration.animation,
      active,
      tone: active ? "active" : "success",
    };
    return {
      label: active ? "Running command" : failed ? "Command failed" : "Ran command",
      detail: command || "",
      category: "command",
      animation: "run-command",
      active,
      tone: failed ? "error" : active ? "active" : "success",
    };
  }
  if (item.type === "fileChange") {
    const count = item.changes?.length || 0;
    return {
      label: active ? "Editing files" : failed ? "File edit failed" : count === 1 ? "Edited a file" : "Edited files",
      detail: (item.changes || []).map((change) => change.path || change.filePath).filter(Boolean).join(", "),
      animation: "edit-files",
      active,
      tone: failed ? "error" : active ? "active" : "success",
    };
  }
  if (item.type === "collabAgentToolCall") {
    const receivers = item.receiverThreadIds || [];
    const count = receivers.length;
    const labels = {
      spawnAgent: ["Starting side task", "Started side task"],
      sendInput: ["Sending input to side task", "Sent input to side task"],
      resumeAgent: ["Resuming side task", "Resumed side task"],
      wait: ["Waiting for side tasks", "Waited for side tasks"],
      closeAgent: ["Closing side task", "Closed side task"],
    };
    const [activeLabel, completedLabel] = labels[item.tool] || ["Updating side task", "Updated side task"];
    return {
      label: active ? activeLabel : failed ? "Side task failed" : completedLabel,
      detail: item.prompt || (count ? `${count} side task${count === 1 ? "" : "s"}` : ""),
      category: "side-task",
      animation: "local-context",
      active,
      tone: failed ? "error" : active ? "active" : "success",
    };
  }
  if (item.type === "subAgentActivity") return {
    label: item.kind === "interrupted" ? "Side task interrupted" : item.kind === "interacted" ? "Side task active" : "Side task started",
    detail: item.agentPath || item.agentThreadId || "",
    category: "side-task",
    animation: "local-context",
    active: item.kind !== "interrupted" && active,
    tone: item.kind === "interrupted" ? "error" : active ? "active" : "success",
  };
  if (item.type === "webSearch") return {
    label: active ? "Searching the web" : failed ? "Search failed" : "Searched the web",
    detail: item.query || "",
    animation: "searching",
    active,
    tone: failed ? "error" : active ? "active" : "success",
  };
  if (item.type === "reasoning") return { label: active ? "Thinking" : "Thought", detail: "", animation: "local-context", active, tone: failed ? "error" : active ? "active" : "success" };
  return { label: active ? "Working" : failed ? "Tool failed" : "Completed", detail: item.tool || item.type || "", animation: "local-context", active, tone: failed ? "error" : active ? "active" : "success" };
}

export function createReviewPreferences(value = {}) {
  return {
    mode: value.mode === "split" ? "split" : "unified",
    wrap: value.wrap === true,
    expanded: value.expanded !== false,
  };
}

export function splitDiffHunk(hunk = { lines: [] }) {
  const rows = [];
  const lines = hunk.lines || [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.type !== "delete" && line.type !== "add") {
      rows.push({ left: line, right: line });
      index++;
      continue;
    }
    const deletes = [];
    const adds = [];
    while (index < lines.length && lines[index].type === "delete") deletes.push(lines[index++]);
    while (index < lines.length && lines[index].type === "add") adds.push(lines[index++]);
    const count = Math.max(deletes.length, adds.length);
    for (let row = 0; row < count; row++) rows.push({ left: deletes[row] || null, right: adds[row] || null });
  }
  return rows;
}

export function permissionRows(permissions = {}) {
  const rows = [];
  if (permissions.network?.enabled) rows.push({ label: "Network", value: "Allow network access" });
  const fs = permissions.fileSystem || {};
  for (const path of fs.read || []) rows.push({ label: "Read", value: path });
  for (const path of fs.write || []) rows.push({ label: "Write", value: path });
  for (const entry of fs.entries || []) {
    const path = entry.path?.path || entry.path?.pattern || entry.path?.value?.kind || "File system";
    rows.push({ label: entry.access?.[0]?.toUpperCase() + entry.access?.slice(1) || "Access", value: path });
  }
  return rows;
}
