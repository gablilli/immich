import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsObject, IsPositive, IsString, ValidateNested } from 'class-validator';
import { Memory } from 'src/database';
import { AssetResponseDto, mapAsset } from 'src/dtos/asset-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetOrderWithRandom, MemoryType } from 'src/enum';
import { Optional, ValidateBoolean, ValidateDate, ValidateEnum, ValidateUUID } from 'src/validation';

class MemoryBaseDto {
  @ValidateBoolean({ optional: true })
  isSaved?: boolean;

  @ValidateDate({ optional: true })
  seenAt?: Date;
}

export class MemorySearchDto {
  @ValidateEnum({ enum: MemoryType, name: 'MemoryType', optional: true })
  type?: MemoryType;

  @ValidateDate({ optional: true })
  for?: Date;

  @ValidateBoolean({ optional: true })
  isTrashed?: boolean;

  @ValidateBoolean({ optional: true })
  isSaved?: boolean;

  @IsInt()
  @IsPositive()
  @Type(() => Number)
  @Optional()
  @ApiProperty({ type: 'integer', description: 'Number of memories to return' })
  size?: number;

  @ValidateEnum({ enum: AssetOrderWithRandom, name: 'MemorySearchOrder', optional: true })
  order?: AssetOrderWithRandom;
}

class OnThisDayDto {
  @IsInt()
  @IsPositive()
  year!: number;
}

class ThemedMemoryDto {
  /** Theme name for display (e.g., themed memory titles like pets, nature, moments) */
  @IsString()
  theme!: string;

  /** Optional search query used to generate this memory */
  @IsString()
  @Optional()
  query?: string;
}

class RememberThisDayDto {
  @IsInt()
  @IsPositive()
  year!: number;

  /** Month of the year (1-12) */
  @IsInt()
  month!: number;

  /** Day of the month (1-31) */
  @IsInt()
  day!: number;
}

type MemoryData = OnThisDayDto | ThemedMemoryDto | RememberThisDayDto;

export class MemoryUpdateDto extends MemoryBaseDto {
  @ValidateDate({ optional: true })
  memoryAt?: Date;
}

export class MemoryCreateDto extends MemoryBaseDto {
  @ValidateEnum({ enum: MemoryType, name: 'MemoryType' })
  type!: MemoryType;

  @IsObject()
  @ValidateNested()
  @Type((options) => {
    switch (options?.object.type) {
      case MemoryType.OnThisDay: {
        return OnThisDayDto;
      }
      case MemoryType.Pets:
      case MemoryType.Nature:
      case MemoryType.Moments: {
        return ThemedMemoryDto;
      }
      case MemoryType.RememberThisDay: {
        return RememberThisDayDto;
      }

      default: {
        return Object;
      }
    }
  })
  data!: MemoryData;

  @ValidateDate()
  memoryAt!: Date;

  @ValidateUUID({ optional: true, each: true })
  assetIds?: string[];
}

export class MemoryStatisticsResponseDto {
  @ApiProperty({ type: 'integer' })
  total!: number;
}

export class MemoryResponseDto {
  id!: string;
  createdAt!: Date;
  updatedAt!: Date;
  deletedAt?: Date;
  memoryAt!: Date;
  seenAt?: Date;
  showAt?: Date;
  hideAt?: Date;
  ownerId!: string;
  @ValidateEnum({ enum: MemoryType, name: 'MemoryType' })
  type!: MemoryType;
  data!: MemoryData;
  isSaved!: boolean;
  assets!: AssetResponseDto[];
}

export const mapMemory = (entity: Memory, auth: AuthDto): MemoryResponseDto => {
  return {
    id: entity.id,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    deletedAt: entity.deletedAt ?? undefined,
    memoryAt: entity.memoryAt,
    seenAt: entity.seenAt ?? undefined,
    showAt: entity.showAt ?? undefined,
    hideAt: entity.hideAt ?? undefined,
    ownerId: entity.ownerId,
    type: entity.type as MemoryType,
    data: entity.data as unknown as MemoryData,
    isSaved: entity.isSaved,
    assets: ('assets' in entity ? entity.assets : []).map((asset) => mapAsset(asset, { auth })),
  };
};
