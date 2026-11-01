import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import {
  Action,
  ActionInput,
  LiveComponent,
  Modelable,
  OnEvent,
  Reactive,
  State,
  dispatchLiveEvent,
  redirectLive,
} from 'nestvexa';

interface MemberReference {
  readonly id: string;
}
/** Event payloads return through the browser; validate them like any action input. */
class MemberReferencePipe implements PipeTransform<unknown, MemberReference> {
  transform(value: unknown): MemberReference {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof Reflect.get(value, 'id') !== 'string' ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(String(Reflect.get(value, 'id')))
    )
      throw new BadRequestException('Expected a member reference');
    return { id: String(Reflect.get(value, 'id')) };
  }
}

/** One keyed child per member. The parent owns `name`; the card owns `kudos`. */
@LiveComponent({ name: 'team-member', view: 'team-member' })
export class TeamMember {
  @Reactive() @State() memberId = '';
  @Reactive() @State() name = '';
  @State() kudos = 0;
  @Action() thank(): void {
    this.kudos++;
  }
  @Action() leave(): void {
    dispatchLiveEvent(this, 'member.left', { id: this.memberId });
  }
}

/** Two-way bound to the board's writable `role` field. */
@LiveComponent({ name: 'team-role-picker', view: 'team-role-picker' })
export class TeamRolePicker {
  @Modelable()
  @State({
    writable: true,
    validate: (value) =>
      typeof value === 'string' &&
      ['viewer', 'editor', 'owner'].includes(value),
  })
  role = 'viewer';
  @Action() chooseEditor(): void {
    this.role = 'editor';
  }
  @Action() chooseOwner(): void {
    this.role = 'owner';
  }
}

/** Rendered after the page loads; its placeholder is ordinary server HTML. */
@LiveComponent({
  name: 'team-stats',
  view: 'team-stats',
  lazy: true,
  placeholder: 'team-stats-placeholder',
})
export class TeamStats {
  @State() summary = 'Team statistics are ready';
}

@LiveComponent({
  name: 'team-board',
  view: 'team-board',
  children: {
    member: TeamMember,
    role: TeamRolePicker,
    stats: TeamStats,
  },
})
export class TeamBoard {
  @State() members = [
    { id: 'ada', name: 'Ada' },
    { id: 'grace', name: 'Grace' },
  ];
  @State({
    writable: true,
    validate: (value) =>
      typeof value === 'string' &&
      ['viewer', 'editor', 'owner'].includes(value),
  })
  role = 'viewer';
  @State() departures = 0;

  @Action() renameGrace(): void {
    this.members = this.members.map((member) =>
      member.id === 'grace' ? { ...member, name: 'Grace Hopper' } : member,
    );
  }
  @Action()
  @OnEvent('member.left')
  memberLeft(@ActionInput(MemberReferencePipe) input: MemberReference): void {
    // The board only removes members it actually holds; unknown ids are ignored.
    const before = this.members.length;
    this.members = this.members.filter((member) => member.id !== input.id);
    if (this.members.length !== before) this.departures++;
  }
  @Action() finish(): void {
    redirectLive(this, '/about');
  }
}
