import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class ImportPublishedDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
