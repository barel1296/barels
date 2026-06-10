import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: 'Validation failed',
        message: result.error.issues.map(
          (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
        ),
      });
    }
    return result.data;
  }
}
