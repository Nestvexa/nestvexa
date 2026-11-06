/** Page props shared by the Nest controller and the three Inertia roots. */
export interface AdminUser {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

export interface SharedProps {
  readonly appName: string;
  readonly framework: string;
  readonly root: string;
  [key: string]: unknown;
}

export interface DashboardProps {
  readonly heading: string;
  readonly framework: string;
  readonly root: string;
  /** Deferred: loaded by a follow-up request after the first render. */
  readonly stats?: { readonly users: number; readonly computedAt: string };
  /** Optional: only sent on a partial reload that asks for it. */
  readonly extra?: string;
}

export interface UsersProps {
  readonly root: string;
  readonly users: readonly AdminUser[];
}

export interface CreateUserProps {
  readonly root: string;
}
