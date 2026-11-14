import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** The TypeORM entity for one note (table `notes`). */
@Entity({ name: 'notes' })
export class NoteEntity {
  @PrimaryGeneratedColumn()
  id!: number;
  @Column({ type: 'text' })
  author!: string;
  @Column({ type: 'text' })
  body!: string;
  @Column({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}
