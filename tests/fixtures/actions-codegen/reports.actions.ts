// Code generation fixture: a long-running job action and a plain action used
// by the framework-target tests.
import 'reflect-metadata';
import {
  ActionGroup,
  ActionInput,
  ServerAction,
  acceptJob,
} from '../../../packages/actions/dist/index.js';

export interface ReportRequest {
  rows: number;
  format?: 'csv' | 'json';
}
export interface ReportFile {
  url: string;
  rows: number;
}

@ActionGroup('reports')
export class ReportActions {
  @ServerAction({ id: 'export', job: true })
  export(@ActionInput() input: ReportRequest) {
    return acceptJob('export-report', async (): Promise<ReportFile> => ({
      url: `/reports/${input.rows}.${input.format ?? 'csv'}`,
      rows: input.rows,
    }));
  }

  @ServerAction({ id: 'rename' })
  rename(@ActionInput() input: { title: string; tags: string[] }): {
    title: string;
  } {
    return { title: input.title };
  }
}
