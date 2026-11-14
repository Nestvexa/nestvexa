import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Versioned schema change, applied by `migrationsRun` when the data source starts. */
export class CreateNotes1794100000000 implements MigrationInterface {
  readonly name = 'CreateNotes1794100000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE "notes" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "author" text NOT NULL, "body" text NOT NULL, "created_at" datetime NOT NULL)',
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "notes"');
  }
}
