import { statSync } from "node:fs";
import { basename } from "node:path";
import { nativeImage } from "electron";
import type { ImageContent, SendMessage } from "@letta-ai/letta-agent-sdk";

/**
 * Image attachment intake for the composer (community-layer port of the
 * Angus attachments doctrine). Policy: 25MB source guard, longest-edge
 * downscale cap of 2000px (preserving aspect), re-encode to JPEG q80 at
 * INTAKE (a modern photo's base64 would bloat every turn's context),
 * batch cap of 4, images LEAD the wire content array.
 */

export const MAX_EDGE = 2000;
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;
export const JPEG_QUALITY = 80;

export interface AttachmentView {
  id: string;
  name: string;
  data: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
}

function downscaleDimensions(width: number, height: number): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE) return null;
  const scale = MAX_EDGE / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function intakeImage(path: string): AttachmentView {
  const name = basename(path);
  const size = statSync(path).size;
  if (size > MAX_SOURCE_BYTES) {
    throw new Error(`${name} is ${(size / 1024 / 1024).toFixed(0)}MB — over the 25MB limit`);
  }
  const source = nativeImage.createFromPath(path);
  if (source.isEmpty()) throw new Error(`${name} could not be read as an image`);
  const { width, height } = source.getSize();
  // Animated formats (gif, webp) decode to their first frame.
  const target = downscaleDimensions(width, height);
  const encoded = target ? source.resize(target) : source;
  const data = encoded.toJPEG(JPEG_QUALITY).toString("base64");
  const sized = encoded.getSize();
  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    data,
    mediaType: "image/jpeg",
    width: sized.width,
    height: sized.height,
  };
}

export function toImageContent(attachments: readonly AttachmentView[]): ImageContent[] {
  return attachments.map((a) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: a.mediaType, data: a.data },
  }));
}

/** Images LEAD the content array (context before instruction). */
export function wireContent(text: string, attachments: readonly AttachmentView[]): SendMessage {
  const images = toImageContent(attachments);
  return images.length
    ? [...images, { type: "text" as const, text }]
    : text;
}

export function intakeFiles(paths: readonly string[]): {
  attachments: AttachmentView[];
  skipped: string[];
} {
  const attachments: AttachmentView[] = [];
  const skipped: string[] = [];
  for (const path of paths) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      skipped.push(`${basename(path)} — over the ${MAX_ATTACHMENTS}-image cap`);
      continue;
    }
    try {
      attachments.push(intakeImage(path));
    } catch (error) {
      skipped.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { attachments, skipped };
}
