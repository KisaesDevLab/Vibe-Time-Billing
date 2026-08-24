// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff-side client file upload: reserve a slot (server picks the
// subfolder by category unless told), PUT the bytes to the presigned URL
// (or the dev mock translator), confirm. Shared by the Files tab's upload
// dialog + drag-and-drop and by the desktop print-to-PDF outbox dialog.

import { api } from '../api-client';

export async function uploadOneClientFile(
  clientId: string,
  file: File,
  category: string,
  subfolderPath?: string,
): Promise<{ fileId: string }> {
  // 1) Reserve a slot — server picks subfolder by category if we don't supply one.
  const reserve = await api<{
    fileId: string;
    storageKey: string;
    uploadUrl: string;
    visibility: 'private' | 'client_visible';
  }>(`/api/staff/clients/${clientId}/files`, {
    method: 'POST',
    body: JSON.stringify({
      category,
      subfolderPath: subfolderPath || undefined,
      originalFilename: file.name,
      sizeBytes: file.size,
      mimeType: file.type || undefined,
    }),
  });

  // 2) Upload the body. mock-presign:// URLs route through the dev-only
  //    translator so the browser doesn't try to fetch an unsupported scheme.
  if (reserve.uploadUrl.startsWith('mock-presign://')) {
    const buf = await file.arrayBuffer();
    const b64 = bufferToBase64(buf);
    await api('/api/staff/admin/storage/upload-mock', {
      method: 'POST',
      body: JSON.stringify({
        url: reserve.uploadUrl,
        contentBase64: b64,
        contentType: file.type || 'application/octet-stream',
      }),
    });
  } else {
    const r = await fetch(reserve.uploadUrl, {
      method: 'PUT',
      headers: file.type ? { 'Content-Type': file.type } : undefined,
      body: file,
    });
    if (!r.ok) throw new Error(`upload_failed_${r.status}`);
  }

  // 3) Confirm.
  await api(`/api/staff/files/${reserve.fileId}/complete`, {
    method: 'POST',
    body: '{}',
  });
  return { fileId: reserve.fileId };
}

export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
