import { BadRequestException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { OnJob } from 'src/decorators';
import { BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { MemoryCreateDto, MemoryResponseDto, MemorySearchDto, MemoryUpdateDto, mapMemory } from 'src/dtos/memory.dto';
import {
  DatabaseLock,
  JobName,
  MemoryType,
  NotificationLevel,
  NotificationType,
  Permission,
  QueueName,
  SystemMetadataKey,
} from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { addAssets, removeAssets } from 'src/utils/asset.util';
import { isSmartSearchEnabled } from 'src/utils/misc';
import { getPreferences } from 'src/utils/preferences';

const DAYS = 3;
const MIN_THEMED_MEMORY_ASSETS = 5;

/** Themed memory configurations for smart search based memories */
const THEMED_MEMORY_CONFIGS = [
  { type: MemoryType.Pets, query: 'cat dog pet animal', theme: 'Miao' },
  { type: MemoryType.Nature, query: 'nature wildlife forest mountain landscape', theme: 'Wild Nature' },
  { type: MemoryType.Moments, query: 'celebration party happy smile joy', theme: 'Moments to Relive' },
];

@Injectable()
export class MemoryService extends BaseService {
  @OnJob({ name: JobName.MemoryGenerate, queue: QueueName.BackgroundTask })
  async onMemoriesCreate() {
    const users = await this.userRepository.getList({ withDeleted: false });

    await this.databaseRepository.withLock(DatabaseLock.MemoryCreation, async () => {
      const state = await this.systemMetadataRepository.get(SystemMetadataKey.MemoriesState);
      const start = DateTime.utc().startOf('day').minus({ days: DAYS });
      const lastOnThisDayDate = state?.lastOnThisDayDate ? DateTime.fromISO(state.lastOnThisDayDate) : start;

      // generate a memory +/- X days from today
      for (let i = 0; i <= DAYS * 2; i++) {
        const target = start.plus({ days: i });
        if (lastOnThisDayDate >= target) {
          continue;
        }

        try {
          await Promise.all(users.map((owner) => this.createOnThisDayMemories(owner.id, target)));
        } catch (error) {
          this.logger.error(`Failed to create memories for ${target.toISO()}: ${error}`);
        }
        // update system metadata even when there is an error to minimize the chance of duplicates
        await this.systemMetadataRepository.set(SystemMetadataKey.MemoriesState, {
          ...state,
          lastOnThisDayDate: target.toISO(),
        });
      }

      // Create themed memories (pets, nature, moments) once per week
      const today = DateTime.utc().startOf('day');
      const lastThemedMemoryDate = state?.lastThemedMemoryDate
        ? DateTime.fromISO(state.lastThemedMemoryDate)
        : today.minus({ days: 7 });

      if (today.diff(lastThemedMemoryDate, 'days').days >= 7) {
        try {
          await Promise.all(users.map((owner) => this.createThemedMemories(owner)));
        } catch (error) {
          this.logger.error(`Failed to create themed memories: ${error}`);
        }
        await this.systemMetadataRepository.set(SystemMetadataKey.MemoriesState, {
          ...state,
          lastOnThisDayDate: state?.lastOnThisDayDate ?? today.toISO()!,
          lastThemedMemoryDate: today.toISO(),
        });
      }
    });
  }

  private async createOnThisDayMemories(ownerId: string, target: DateTime) {
    const showAt = target.startOf('day').toISO();
    const hideAt = target.endOf('day').toISO();
    const memories = await this.assetRepository.getByDayOfYear([ownerId], target);
    await Promise.all(
      memories.map(({ year, assets }) =>
        this.memoryRepository.create(
          {
            ownerId,
            type: MemoryType.OnThisDay,
            data: { year },
            memoryAt: target.set({ year }).toISO()!,
            showAt,
            hideAt,
          },
          new Set(assets.map(({ id }) => id)),
        ),
      ),
    );
  }

  /**
   * Creates themed memories based on smart search for pets, nature, moments, etc.
   * These memories are grouped by theme rather than by date.
   */
  private async createThemedMemories(owner: { id: string; metadata: unknown[] }) {
    const preferences = getPreferences(owner.metadata as any);
    if (!preferences.memories.themedMemoriesEnabled) {
      return;
    }

    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      this.logger.debug('Smart search not enabled, skipping themed memories');
      return;
    }

    const today = DateTime.utc().startOf('day');
    const showAt = today.toISO();
    const hideAt = today.plus({ days: 7 }).endOf('day').toISO();

    for (const config of THEMED_MEMORY_CONFIGS) {
      try {
        // Use smart search to find relevant assets
        const embedding = await this.machineLearningRepository.encodeText(config.query, {
          modelName: machineLearning.clip.modelName,
        });

        const { items } = await this.searchRepository.searchSmart(
          { page: 1, size: 20 },
          {
            embedding,
            userIds: [owner.id],
          },
        );

        if (items.length < MIN_THEMED_MEMORY_ASSETS) {
          continue;
        }

        const memory = await this.memoryRepository.create(
          {
            ownerId: owner.id,
            type: config.type,
            data: { theme: config.theme, query: config.query },
            memoryAt: today.toISO()!,
            showAt,
            hideAt,
          },
          new Set(items.map(({ id }) => id)),
        );

        // Create notification for new memory if enabled
        if (preferences.memories.notificationsEnabled) {
          await this.createMemoryNotification(owner.id, memory.id, config.theme);
        }
      } catch (error) {
        this.logger.error(`Failed to create themed memory ${config.type} for user ${owner.id}: ${error}`);
      }
    }
  }

  /**
   * Creates a notification for a new memory
   */
  private async createMemoryNotification(userId: string, memoryId: string, theme: string) {
    try {
      await this.notificationRepository.create({
        userId,
        type: NotificationType.NewMemory,
        level: NotificationLevel.Info,
        title: 'memory_new_notification_title',
        description: theme,
        data: { memoryId, theme },
      });
    } catch (error) {
      this.logger.error(`Failed to create memory notification: ${error}`);
    }
  }

  @OnJob({ name: JobName.MemoryCleanup, queue: QueueName.BackgroundTask })
  async onMemoriesCleanup() {
    await this.memoryRepository.cleanup();
  }

  async search(auth: AuthDto, dto: MemorySearchDto) {
    const memories = await this.memoryRepository.search(auth.user.id, dto);
    return memories.map((memory) => mapMemory(memory, auth));
  }

  statistics(auth: AuthDto, dto: MemorySearchDto) {
    return this.memoryRepository.statistics(auth.user.id, dto);
  }

  async get(auth: AuthDto, id: string): Promise<MemoryResponseDto> {
    await this.requireAccess({ auth, permission: Permission.MemoryRead, ids: [id] });
    const memory = await this.findOrFail(id);
    return mapMemory(memory, auth);
  }

  async create(auth: AuthDto, dto: MemoryCreateDto) {
    // TODO validate type/data combination

    const assetIds = dto.assetIds || [];
    const allowedAssetIds = await this.checkAccess({
      auth,
      permission: Permission.AssetShare,
      ids: assetIds,
    });
    const memory = await this.memoryRepository.create(
      {
        ownerId: auth.user.id,
        type: dto.type,
        data: dto.data,
        isSaved: dto.isSaved,
        memoryAt: dto.memoryAt,
        seenAt: dto.seenAt,
      },
      allowedAssetIds,
    );

    return mapMemory(memory, auth);
  }

  async update(auth: AuthDto, id: string, dto: MemoryUpdateDto): Promise<MemoryResponseDto> {
    await this.requireAccess({ auth, permission: Permission.MemoryUpdate, ids: [id] });

    const memory = await this.memoryRepository.update(id, {
      isSaved: dto.isSaved,
      memoryAt: dto.memoryAt,
      seenAt: dto.seenAt,
    });

    return mapMemory(memory, auth);
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.MemoryDelete, ids: [id] });
    await this.memoryRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.MemoryRead, ids: [id] });

    const repos = { access: this.accessRepository, bulk: this.memoryRepository };
    const results = await addAssets(auth, repos, { parentId: id, assetIds: dto.ids });

    const hasSuccess = results.find(({ success }) => success);
    if (hasSuccess) {
      await this.memoryRepository.update(id, { updatedAt: new Date() });
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.MemoryUpdate, ids: [id] });

    const repos = { access: this.accessRepository, bulk: this.memoryRepository };
    const results = await removeAssets(auth, repos, {
      parentId: id,
      assetIds: dto.ids,
      canAlwaysRemove: Permission.MemoryDelete,
    });

    const hasSuccess = results.find(({ success }) => success);
    if (hasSuccess) {
      await this.memoryRepository.update(id, { id, updatedAt: new Date() });
    }

    return results;
  }

  private async findOrFail(id: string) {
    const memory = await this.memoryRepository.get(id);
    if (!memory) {
      throw new BadRequestException('Memory not found');
    }
    return memory;
  }
}
