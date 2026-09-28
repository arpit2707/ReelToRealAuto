import { Injectable, Logger } from '@nestjs/common';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * Post images and Reel videos in S3-compatible object storage (Cloudflare R2
 * or AWS S3), so the database does not fill up with image bytes. Configured
 * with S3_ENDPOINT (R2: https://<account>.r2.cloudflarestorage.com; leave empty
 * for AWS), S3_REGION ("auto" for R2), S3_BUCKET, S3_ACCESS_KEY_ID and
 * S3_SECRET_ACCESS_KEY. Without them everything stays in Postgres as before.
 */
@Injectable()
export class MediaStore {
  private readonly logger = new Logger(MediaStore.name);
  private client: S3Client | null = null;

  isConfigured(): boolean {
    return Boolean(
      process.env.S3_BUCKET &&
      process.env.S3_ACCESS_KEY_ID &&
      process.env.S3_SECRET_ACCESS_KEY,
    );
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.s3().send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: data,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.s3().send(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
    );
    if (!res.Body) throw new Error(`Object ${key} is empty`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  private s3(): S3Client {
    if (!this.client) {
      const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
      this.client = new S3Client({
        region: process.env.S3_REGION || (endpoint ? 'auto' : 'ap-south-1'),
        endpoint,
        forcePathStyle: Boolean(endpoint),
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
        },
      });
      this.logger.log(
        `Post media goes to bucket ${process.env.S3_BUCKET}${endpoint ? ` at ${endpoint}` : ''}`,
      );
    }
    return this.client;
  }
}
