import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class PostInsightsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  days = 30;
}
