import { IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export class ConfirmPublishedDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  releaseId: string;

  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  releaseURL: string;
}
