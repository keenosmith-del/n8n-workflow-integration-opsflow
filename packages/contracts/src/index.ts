import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  IsInt,
  Min,
  Max,
  IsIn,
  IsOptional,
  IsUUID,
  IsBoolean,
  ValidateNested,
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
export const statuses = [
  'QUEUED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'COMPLETED',
  'INSUFFICIENT_BUDGET',
  'FAILED',
  'TIMED_OUT',
] as const;
export type Role = 'EMPLOYEE' | 'MANAGER' | 'ADMIN';
export class LoginDto {
  @ApiProperty({ example: 'employee@opsflow.local' }) @IsEmail() email!: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(128) password!: string;
}
export class RequestDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(120) title!: string;
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(2000) justification!: string;
  @ApiProperty({ example: 100000, description: 'Integer minor units (ZAR cents)' })
  @IsInt()
  @Min(100)
  @Max(100000000)
  amountCents!: number;
  @ApiProperty({ default: 'IT' }) @IsIn(['IT', 'OPERATIONS']) department!: string;
  @ApiProperty({
    default: 'normal',
    enum: ['normal', 'finance_failure', 'supplier_failure', 'missing_quotes', 'timeout'],
  })
  @IsIn(['normal', 'finance_failure', 'supplier_failure', 'missing_quotes', 'timeout'])
  scenario!: string;
}
export class DecisionDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] }) @IsIn(['APPROVE', 'REJECT']) decision!:
    | 'APPROVE'
    | 'REJECT';
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(1000) comment!: string;
}
export class RuleDto {
  @ApiProperty() @IsInt() @Min(0) @Max(100000000) minCents!: number;
  @ApiProperty() @IsUUID() managerId!: string;
}
export class WorkflowDto {
  @ApiProperty({ enum: ['procurement-v1'] }) @IsIn(['procurement-v1']) template!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(10080) approvalTimeoutMinutes!: number;
  @ApiProperty({ type: [RuleDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RuleDto)
  rules!: RuleDto[];
}
export class IntegrationDto {
  @ApiProperty({ enum: ['finance', 'suppliers'] }) @IsIn(['finance', 'suppliers']) name!: string;
  @ApiProperty({ enum: ['api-key', 'oauth2-client-credentials'] })
  @IsIn(['api-key', 'oauth2-client-credentials'])
  authType!: string;
  @ApiPropertyOptional({ description: 'Write only; leave blank to retain stored credential' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  secret?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128) clientId?: string;
  @ApiProperty() @IsBoolean() enabled!: boolean;
}
export class QuoteDto {
  @ApiProperty() @IsIn(['atlas', 'nova']) supplierId!: string;
  @ApiProperty() @IsString() @MaxLength(100) reference!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(100000000) amountCents!: number;
  @ApiProperty() @IsInt() @Min(1) @Max(90) deliveryDays!: number;
}
export class CallbackDto {
  @ApiProperty() @IsUUID() executionId!: string;
  @ApiProperty() @IsInt() @Min(1) attempt!: number;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(256) callbackKey!: string;
  @ApiProperty({ enum: ['COLLECT', 'FINALIZE'] }) @IsIn(['COLLECT', 'FINALIZE']) phase!: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() financeOk?: boolean;
  @ApiPropertyOptional({ type: [QuoteDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => QuoteDto)
  quotes?: QuoteDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) error?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) n8nExecutionId?: string;
}
