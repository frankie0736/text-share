import {
  clearSessionCookie,
  createSessionCookie,
  isValidPassword,
  verifySession,
} from "./auth";
import type { Env, ItemRow, RenderItem } from "./types";

const DEFAULT_TTL_DAYS = 7;
const MAX_TTL_DAYS = 1095;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const CLEANUP_BATCH_SIZE = 100;

const INSERT_ITEM = `
INSERT INTO items (
  id, kind, r2_key, file_name, file_type, file_size, created_at, expires_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const SELECT_ACTIVE_ITEMS = `
SELECT id, kind, r2_key, file_name, file_type, file_size, created_at, expires_at
FROM items
WHERE expires_at > ?
ORDER BY created_at DESC
LIMIT 100
`;

const SELECT_ACTIVE_ITEM = `
SELECT id, kind, r2_key, file_name, file_type, file_size, created_at, expires_at
FROM items
WHERE id = ? AND expires_at > ?
LIMIT 1
`;

const SELECT_EXPIRED_ITEMS = `
SELECT id, r2_key
FROM items
WHERE expires_at <= ?
LIMIT ?
`;

function logEvent(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function parseTtlDays(value: unknown): number | null {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "7";
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_TTL_DAYS) return null;
  return days;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeFileName(value: string): string {
  const clean = value
    .replace(/[\\/:"*?<>|\r\n]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return clean || "download";
}

function contentDisposition(fileName: string): string {
  const asciiFallback = safeFileName(fileName).replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function safeRedirectPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function redirect(location: string, status = 303): Response {
  return new Response(null, { status, headers: { location } });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function renderShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#1f2937}.wrap{max-width:1180px;margin:0 auto;padding:24px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}h1{font-size:24px;margin:0}h2{font-size:16px;margin:0 0 12px}.layout{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(320px,1fr);gap:18px;align-items:start}.panel,.item{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:14px}.meta{font-size:12px;color:#6b7280}.muted{color:#6b7280;font-size:13px}.error{background:#fef2f2;border-color:#fecaca;color:#991b1b}.toolbar{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.ttl{width:140px}.fill{flex:1 1 auto}label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}input,textarea{width:100%;border:1px solid #d1d5db;border-radius:6px;padding:9px 10px;font:inherit;background:#fff}textarea{min-height:220px;resize:vertical}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}button,.button{border:0;border-radius:6px;background:#2563eb;color:#fff;padding:9px 12px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block}.secondary{background:#374151}.danger{background:#dc2626}.ghost{background:#e5e7eb;color:#111827}.icon-delete{position:absolute;top:10px;right:10px;width:30px;height:30px;padding:0;border-radius:999px;background:#fee2e2;color:#991b1b;font-size:18px;line-height:30px}.download-icon{position:absolute;top:10px;right:48px;width:42px;height:30px;padding:0;border-radius:8px;background:#e5e7eb;color:#111827;text-align:center;line-height:30px;font-size:18px;font-weight:800}.download-icon:hover{background:#d1d5db}.item{position:relative}.text-item pre{margin:12px 0 0;background:#111827;color:#f9fafb;border-radius:8px;padding:14px;overflow:auto;white-space:pre-wrap;word-break:break-word}.text-actions{padding-right:38px}.dropzone{border:2px dashed #cbd5e1;border-radius:8px;padding:22px;text-align:center;background:#f8fafc;cursor:pointer;transition:border-color .15s,background .15s}.dropzone.dragging{border-color:#2563eb;background:#eff6ff}.dropzone strong{display:block;margin-bottom:6px}.file-list{display:grid;gap:10px}.document-item{position:relative;border:1px solid #e5e7eb;border-radius:8px;background:#fff;padding:12px 96px 12px 12px;cursor:pointer}.document-item:hover{border-color:#93c5fd;background:#f8fbff}.file-heading{display:flex;align-items:baseline;gap:7px;min-width:0}.file-name-text{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-size-inline{flex:0 0 auto;font-size:12px;color:#6b7280}.hidden{display:none}@media(max-width:860px){.wrap{padding:14px}.layout{grid-template-columns:1fr}.ttl{width:100%}header{align-items:flex-start;flex-direction:column}}
</style>
</head>
<body><div class="wrap">${body}</div>
<script>
function copyText(text){navigator.clipboard.writeText(text)}
function copyFrom(id){const el=document.getElementById(id); if(el) copyText(el.innerText)}
function confirmDelete(){return confirm('确认删除这条内容？')}
function absolutePath(path){return new URL(path, location.href).href}
document.addEventListener('click',(event)=>{
  const target=event.target;
  if(!(target instanceof Element)) return;
  const row=target.closest('[data-copy-download]');
  if(!row || target.closest('a,button,form,input')) return;
  copyText(absolutePath(row.getAttribute('data-copy-download') || '/'));
});
const dropZone=document.querySelector('[data-dropzone="true"]');
const fileInput=document.querySelector('[data-file-input="true"]');
const documentTtl=document.querySelector('[data-document-ttl="true"]');
function hasFiles(event){return Array.from(event.dataTransfer?.types || []).includes('Files')}
function clearDropState(){dropZone?.classList.remove('dragging')}
async function uploadFiles(files){
  const selected=Array.from(files || []).filter(file=>file.size>0);
  if(selected.length===0) return;
  let ok=0;
  for(const file of selected){
    const form=new FormData();
    form.set('file', file);
    form.set('ttl_days', documentTtl?.value || '${DEFAULT_TTL_DAYS}');
    const response=await fetch('/documents',{method:'POST',body:form,credentials:'same-origin'});
    if(response.ok || response.status===303){ok++}else{alert(file.name+' 上传失败：'+response.status)}
  }
  if(ok>0) location.reload();
}
for(const name of ['dragenter','dragover','drop']){
  document.addEventListener(name,(event)=>{if(hasFiles(event)){event.preventDefault()}});
}
document.addEventListener('dragleave',(event)=>{if(event.clientX<=0||event.clientY<=0||event.clientX>=innerWidth||event.clientY>=innerHeight)clearDropState()});
document.addEventListener('drop',(event)=>{if(hasFiles(event)&&!dropZone?.contains(event.target))clearDropState()});
dropZone?.addEventListener('click',()=>fileInput?.click());
dropZone?.addEventListener('dragenter',(event)=>{if(hasFiles(event)){event.preventDefault();dropZone.classList.add('dragging')}});
dropZone?.addEventListener('dragover',(event)=>{if(hasFiles(event)){event.preventDefault();dropZone.classList.add('dragging')}});
dropZone?.addEventListener('dragleave',(event)=>{if(!dropZone.contains(event.relatedTarget))clearDropState()});
dropZone?.addEventListener('drop',(event)=>{if(!hasFiles(event))return;event.preventDefault();event.stopPropagation();clearDropState();uploadFiles(event.dataTransfer.files)});
fileInput?.addEventListener('change',()=>uploadFiles(fileInput.files));
</script>
</body></html>`;
}

function renderLogin(error = "", redirectTo = "/"): string {
  return renderShell(
    "内部共享板登录",
    `<div class="panel" style="max-width:420px;margin:80px auto">
      <h1>内部共享板</h1>
      <p class="muted">输入内部访问密码。</p>
      ${error ? `<div class="panel error">${escapeHtml(error)}</div>` : ""}
      <form method="post" action="/login">
        <input type="hidden" name="redirect" value="${escapeHtml(redirectTo)}">
        <label>密码</label>
        <input type="password" name="password" autofocus required>
        <div class="actions"><button type="submit">登录</button></div>
      </form>
    </div>`,
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function renderTextItem(item: RenderItem): string {
  const codeId = `text-${item.id}`;
  return `<div class="item text-item">
    <form method="post" action="/items/${item.id}/delete" onsubmit="return confirmDelete()">
      <button class="icon-delete" type="submit" title="删除">×</button>
    </form>
    <div class="text-actions">
      <div class="meta">创建 ${escapeHtml(formatDate(item.created_at))} · 过期 ${escapeHtml(formatDate(item.expires_at))}</div>
      <pre><code id="${codeId}">${escapeHtml(item.text_body ?? "")}</code></pre>
      <div class="actions">
        <button type="button" class="secondary" onclick="copyFrom('${codeId}')">复制</button>
        <a class="button ghost" href="/items/${item.id}/download">下载 .md</a>
      </div>
    </div>
  </div>`;
}

function renderDocumentItem(item: ItemRow): string {
  const downloadPath = `/items/${item.id}/download`;
  return `<div class="document-item" data-copy-download="${downloadPath}" title="点击复制链接">
    <a class="download-icon" href="${downloadPath}" aria-label="下载" title="下载">⇩</a>
    <form method="post" action="/items/${item.id}/delete" onsubmit="return confirmDelete()">
      <button class="icon-delete" type="submit" title="删除">×</button>
    </form>
    <div class="file-heading"><span class="file-name-text">${escapeHtml(item.file_name ?? "download")}</span><span class="file-size-inline">${formatBytes(item.file_size)}</span></div>
    <div class="meta">上传日期 ${escapeHtml(formatDate(item.created_at))}</div>
    <div class="meta">过期 ${escapeHtml(formatDate(item.expires_at))}</div>
  </div>`;
}

function renderHome(items: RenderItem[], error = ""): string {
  const texts = items.filter((item) => item.kind === "text");
  const documents = items.filter((item) => item.kind === "document");
  return renderShell(
    "内部共享板",
    `<header>
      <div><h1>内部共享板</h1><div class="muted">Markdown 文本和文档，默认保留 7 天。</div></div>
      <form method="post" action="/logout"><button class="ghost" type="submit">退出</button></form>
    </header>
    ${error ? `<div class="panel error">${escapeHtml(error)}</div>` : ""}
    <div class="layout">
      <main>
        <section class="panel">
          <h2>Markdown 文本</h2>
          <form method="post" action="/texts">
            <p><label>正文</label><textarea name="content" maxlength="${MAX_TEXT_BYTES}" placeholder="在这里粘贴或输入 Markdown..." required></textarea></p>
            <div class="toolbar">
              <div class="ttl"><label>有效期（天）</label><input name="ttl_days" type="number" min="1" max="${MAX_TTL_DAYS}" value="${DEFAULT_TTL_DAYS}"></div>
              <div class="fill"></div>
              <button type="submit">保存文本</button>
            </div>
          </form>
        </section>
        <section>
          <h2>Markdown List（${texts.length}）</h2>
          ${texts.length ? texts.map(renderTextItem).join("") : '<div class="panel muted">暂无 Markdown 文本。</div>'}
        </section>
      </main>
      <aside>
        <section class="panel">
          <h2>文档上传</h2>
          <div class="dropzone" data-dropzone="true">
            <strong>拖拽文件到这里自动上传</strong>
            <span class="muted">文件经过窗口不会上传，只有放到这个区域才上传。</span>
          </div>
          <input class="hidden" data-file-input="true" type="file" multiple>
          <div class="toolbar" style="margin-top:12px">
            <div class="ttl"><label>有效期（天）</label><input data-document-ttl="true" type="number" min="1" max="${MAX_TTL_DAYS}" value="${DEFAULT_TTL_DAYS}"></div>
          </div>
        </section>
        <section>
          <h2>文件列表（${documents.length}）</h2>
          <div class="file-list">
            ${documents.length ? documents.map(renderDocumentItem).join("") : '<div class="panel muted">暂无文档。</div>'}
          </div>
        </section>
      </aside>
    </div>`,
  );
}

async function loadActiveItems(env: Env, now = nowSeconds()): Promise<RenderItem[]> {
  const result = await env.DB.prepare(SELECT_ACTIVE_ITEMS).bind(now).all<ItemRow>();
  const rows = result.results ?? [];
  return Promise.all(
    rows.map(async (item) => {
      if (item.kind !== "text") return item;
      const object = await env.BUCKET.get(item.r2_key);
      return { ...item, text_body: object ? await object.text() : "[正文缺失]" };
    }),
  );
}

async function renderHomeResponse(
  env: Env,
  status = 200,
  error = "",
): Promise<Response> {
  return htmlResponse(renderHome(await loadActiveItems(env), error), status);
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    const redirectTo = safeRedirectPath(new URL(request.url).searchParams.get("redirect"));
    return htmlResponse(renderLogin("", redirectTo));
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const form = await request.formData();
  const redirectTo = safeRedirectPath(form.get("redirect"));
  const password = String(form.get("password") ?? "");
  if (!(await isValidPassword(password, env))) {
    return htmlResponse(renderLogin("密码错误", redirectTo), 401);
  }
  const response = redirect(redirectTo);
  response.headers.set("set-cookie", await createSessionCookie(env));
  return response;
}

async function insertItem(
  env: Env,
  item: ItemRow,
): Promise<void> {
  await env.DB.prepare(INSERT_ITEM)
    .bind(
      item.id,
      item.kind,
      item.r2_key,
      item.file_name,
      item.file_type,
      item.file_size,
      item.created_at,
      item.expires_at,
    )
    .run();
}

async function handleCreateText(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const form = await request.formData();
  const ttlDays = parseTtlDays(form.get("ttl_days"));
  if (!ttlDays) return renderHomeResponse(env, 400, "有效期必须是 1 到 1095 天");
  const content = String(form.get("content") ?? "");
  if (!content.trim()) return renderHomeResponse(env, 400, "Markdown 内容不能为空");
  if (byteLength(content) > MAX_TEXT_BYTES) {
    return renderHomeResponse(env, 413, "Markdown 内容不能超过 256 KB");
  }

  const id = crypto.randomUUID();
  const createdAt = nowSeconds();
  const r2Key = `texts/${id}.md`;
  const item: ItemRow = {
    id,
    kind: "text",
    r2_key: r2Key,
    file_name: "text.md",
    file_type: "text/markdown; charset=utf-8",
    file_size: byteLength(content),
    created_at: createdAt,
    expires_at: createdAt + ttlDays * 24 * 60 * 60,
  };

  await env.BUCKET.put(r2Key, content, {
    httpMetadata: { contentType: item.file_type ?? undefined },
    customMetadata: { item_id: id, kind: item.kind },
  });
  try {
    await insertItem(env, item);
  } catch (error) {
    await env.BUCKET.delete(r2Key);
    throw error;
  }
  logEvent({
    request_id: requestId,
    action: "create_text",
    item_id: id,
    bytes: item.file_size,
    expires_at: item.expires_at,
    result: "ok",
  });
  return redirect("/");
}

async function handleCreateDocument(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const form = await request.formData();
  const ttlDays = parseTtlDays(form.get("ttl_days"));
  if (!ttlDays) return renderHomeResponse(env, 400, "有效期必须是 1 到 1095 天");
  const upload = form.get("file") as unknown;
  if (!(upload instanceof File) || upload.size === 0) {
    return renderHomeResponse(env, 400, "文件不能为空");
  }
  if (upload.size > MAX_UPLOAD_BYTES) {
    return renderHomeResponse(env, 413, "文件不能超过 25 MB");
  }

  const id = crypto.randomUUID();
  const createdAt = nowSeconds();
  const fileName = safeFileName(upload.name);
  const r2Key = `documents/${id}/${fileName}`;
  const item: ItemRow = {
    id,
    kind: "document",
    r2_key: r2Key,
    file_name: fileName,
    file_type: upload.type || "application/octet-stream",
    file_size: upload.size,
    created_at: createdAt,
    expires_at: createdAt + ttlDays * 24 * 60 * 60,
  };

  await env.BUCKET.put(r2Key, await upload.arrayBuffer(), {
    httpMetadata: { contentType: item.file_type ?? undefined },
    customMetadata: { item_id: id, kind: item.kind },
  });
  try {
    await insertItem(env, item);
  } catch (error) {
    await env.BUCKET.delete(r2Key);
    throw error;
  }
  logEvent({
    request_id: requestId,
    action: "create_document",
    item_id: id,
    file_name: item.file_name,
    bytes: item.file_size,
    expires_at: item.expires_at,
    result: "ok",
  });
  return redirect("/");
}

async function getActiveItem(
  env: Env,
  id: string,
  now = nowSeconds(),
): Promise<ItemRow | null> {
  return env.DB.prepare(SELECT_ACTIVE_ITEM).bind(id, now).first<ItemRow>();
}

async function handleDownload(env: Env, id: string): Promise<Response> {
  const item = await getActiveItem(env, id);
  if (!item) return new Response("Not Found", { status: 404 });
  const object = await env.BUCKET.get(item.r2_key);
  if (!object) return new Response("Not Found", { status: 404 });
  const fileName = item.file_name ?? "download";
  const headers = new Headers({
    "content-disposition": contentDisposition(fileName),
  });
  object.writeHttpMetadata(headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", item.file_type ?? "application/octet-stream");
  }
  return new Response(object.body, { headers });
}

async function handleDelete(
  env: Env,
  id: string,
  requestId: string,
): Promise<Response> {
  const item = await getActiveItem(env, id);
  if (!item) return new Response("Not Found", { status: 404 });
  await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id).run();
  try {
    await env.BUCKET.delete(item.r2_key);
  } catch (error) {
    logEvent({
      request_id: requestId,
      action: "delete_r2_after_db_delete",
      item_id: id,
      result: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  logEvent({
    request_id: requestId,
    action: "delete_item",
    item_id: id,
    kind: item.kind,
    result: "ok",
  });
  return redirect("/");
}

async function route(request: Request, env: Env, requestId: string): Promise<Response> {
  const parsed = new URL(request.url);
  const pathname = parsed.pathname;

  if (pathname === "/login") return handleLogin(request, env);

  const authenticated = await verifySession(request, env);
  if (!authenticated) {
    if (request.method === "GET") {
      const target = pathname === "/" ? "/login" : `/login?redirect=${encodeURIComponent(pathname)}`;
      return redirect(target);
    }
    return redirect("/login");
  }

  if (pathname === "/" && request.method === "GET") {
    return renderHomeResponse(env);
  }
  if (pathname === "/logout" && request.method === "POST") {
    const response = redirect("/login");
    response.headers.set("set-cookie", clearSessionCookie());
    return response;
  }
  if (pathname === "/texts" && request.method === "POST") {
    return handleCreateText(request, env, requestId);
  }
  if (pathname === "/documents" && request.method === "POST") {
    return handleCreateDocument(request, env, requestId);
  }

  const downloadMatch = pathname.match(/^\/items\/([^/]+)\/download$/);
  if (downloadMatch && request.method === "GET") {
    return handleDownload(env, decodeURIComponent(downloadMatch[1]));
  }

  const deleteMatch = pathname.match(/^\/items\/([^/]+)\/delete$/);
  if (deleteMatch && request.method === "POST") {
    return handleDelete(env, decodeURIComponent(deleteMatch[1]), requestId);
  }

  return new Response("Not Found", { status: 404 });
}

function withRequestId(response: Response, requestId: string): Response {
  response.headers.set("x-request-id", requestId);
  return response;
}

export async function handleRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    return withRequestId(await route(request, env, requestId), requestId);
  } catch (error) {
    logEvent({
      request_id: requestId,
      action: "request_error",
      result: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    return withRequestId(new Response("Internal Server Error", { status: 500 }), requestId);
  }
}

export async function cleanupExpired(
  env: Env,
  now = nowSeconds(),
): Promise<{ deleted: number; failed: number }> {
  const expired = await env.DB.prepare(SELECT_EXPIRED_ITEMS)
    .bind(now, CLEANUP_BATCH_SIZE)
    .all<Pick<ItemRow, "id" | "r2_key">>();
  let deleted = 0;
  let failed = 0;
  for (const item of expired.results ?? []) {
    try {
      await env.BUCKET.delete(item.r2_key);
      await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(item.id).run();
      deleted++;
    } catch (error) {
      failed++;
      logEvent({
        action: "cleanup_expired",
        item_id: item.id,
        result: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logEvent({ action: "cleanup_expired", deleted, failed, result: "ok" });
  return { deleted, failed };
}

export default {
  fetch: handleRequest,
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await cleanupExpired(env);
  },
};
