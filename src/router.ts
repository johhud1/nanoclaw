import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { Channel, MediaPayload, MediaType, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';
import { logger } from './logger.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

const MIME_TYPES: Record<MediaType, Record<string, string>> = {
  image: {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  },
  video: {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    webm: 'video/webm',
  },
  audio: {
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
  },
  document: {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain',
    zip: 'application/zip',
  },
};

export function inferMimeType(filename: string, type: MediaType): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[type][ext] || 'application/octet-stream';
}

/**
 * Translate container paths to host paths.
 * Container /workspace/ipc/ → Host DATA_DIR/ipc/{groupFolder}/
 * Container /workspace/group/ → Host GROUPS_DIR/{groupFolder}/
 */
function translateContainerPath(
  containerPath: string,
  groupFolder: string,
): string {
  // Container IPC path → Host IPC path
  if (containerPath.startsWith('/workspace/ipc/')) {
    const relativePath = containerPath.slice('/workspace/ipc/'.length);
    return path.join(DATA_DIR, 'ipc', groupFolder, relativePath);
  }

  // Container group path → Host groups path
  if (containerPath.startsWith('/workspace/group/')) {
    const relativePath = containerPath.slice('/workspace/group/'.length);
    return path.join(GROUPS_DIR, groupFolder, relativePath);
  }

  // Legacy format: /workspace/{groupFolder}/
  const legacyPrefix = `/workspace/${groupFolder}/`;
  if (containerPath.startsWith(legacyPrefix)) {
    const relativePath = containerPath.slice(legacyPrefix.length);
    return path.join(GROUPS_DIR, groupFolder, relativePath);
  }

  // Not a container path, return as-is
  return containerPath;
}

export async function resolveMediaBuffer(
  media: MediaPayload,
  groupFolder: string,
): Promise<Buffer> {
  if (media.data) {
    return Buffer.from(media.data, 'base64');
  }

  if (media.filePath) {
    // Translate container path to host path
    const hostPath = translateContainerPath(media.filePath, groupFolder);

    // Security: validate the resolved host path is within allowed directories
    const resolved = path.resolve(hostPath);
    const allowedIpcDir = path.resolve(DATA_DIR, 'ipc', groupFolder);
    const allowedGroupDir = path.resolve(GROUPS_DIR, groupFolder);

    if (
      !resolved.startsWith(allowedIpcDir) &&
      !resolved.startsWith(allowedGroupDir)
    ) {
      throw new Error(
        `Media path must be within group folder or IPC directory`,
      );
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`Media file not found: ${media.filePath}`);
    }

    return fs.readFileSync(resolved);
  }

  if (media.url) {
    const response = await fetch(media.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch media URL: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  throw new Error('Media must have data, filePath, or url');
}

export async function routeMediaOutbound(
  channels: Channel[],
  jid: string,
  media: MediaPayload,
  groupFolder: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());

  if (!channel) {
    throw new Error(`No channel for JID: ${jid}`);
  }

  if (channel.sendMedia) {
    await channel.sendMedia(jid, media);
    return;
  }

  // Graceful degradation: send caption as text if channel doesn't support media
  if (media.caption) {
    logger.warn(
      { jid, channel: channel.name, mediaType: media.type },
      'Channel does not support media, sending caption as text',
    );
    await channel.sendMessage(jid, `[${media.type}] ${media.caption}`);
  } else {
    logger.warn(
      { jid, channel: channel.name, mediaType: media.type },
      'Channel does not support media and no caption provided, skipping',
    );
  }
}
