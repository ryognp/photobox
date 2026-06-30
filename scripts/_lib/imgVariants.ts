import sharp from "sharp";

export interface VariantResult {
  thumbnailBuffer: Buffer | null;
  previewBuffer: Buffer | null;
  widthPx: number | null;
  heightPx: number | null;
  warnings: string[];
}

export async function generateVariants(
  originalBuffer: Buffer,
  thumbnailSize = 320,
  thumbnailQuality = 78,
  previewSize = 1600,
  previewQuality = 85,
): Promise<VariantResult> {
  const warnings: string[] = [];
  let widthPx: number | null = null;
  let heightPx: number | null = null;
  let thumbnailBuffer: Buffer | null = null;
  let previewBuffer: Buffer | null = null;

  // Get metadata
  try {
    const meta = await sharp(originalBuffer).metadata();
    widthPx = meta.width ?? null;
    heightPx = meta.height ?? null;
  } catch (err) {
    warnings.push(`Failed to read image metadata: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Generate thumbnail
  try {
    thumbnailBuffer = await sharp(originalBuffer)
      .resize({
        width: thumbnailSize,
        height: thumbnailSize,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: thumbnailQuality })
      .toBuffer();
  } catch (err) {
    warnings.push(`Failed to generate thumbnail: ${err instanceof Error ? err.message : String(err)}`);
    thumbnailBuffer = null;
  }

  // Generate preview
  try {
    previewBuffer = await sharp(originalBuffer)
      .resize({
        width: previewSize,
        height: previewSize,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: previewQuality })
      .toBuffer();
  } catch (err) {
    warnings.push(`Failed to generate preview: ${err instanceof Error ? err.message : String(err)}`);
    previewBuffer = null;
  }

  return { thumbnailBuffer, previewBuffer, widthPx, heightPx, warnings };
}
