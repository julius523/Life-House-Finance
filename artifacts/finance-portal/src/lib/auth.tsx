import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type UserRole = "admin" | "approver" | "submitter";

export type AuthUser = {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
};

type AuthState = {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

const API_BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "") + "/api";

async function apiJson<T>(
  path: string,
  init?: RequestInit & { body?: unknown },
): Promise<T> {
  const body =
    init?.body && typeof init.body !== "string"
      ? JSON.stringify(init.body)
      : (init?.body as string | undefined);
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    body,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const data = await apiJson<{ user: AuthUser }>("/auth/me");
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const login = async (email: string, password: string) => {
    const data = await apiJson<{ user: AuthUser }>("/auth/login", {
      method: "POST",
      body: { email, password },
    });
    setUser(data.user);
  };

  const logout = async () => {
    try {
      await apiJson("/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function canAccess(role: UserRole | undefined, section: Section): boolean {
  if (!role) return false;
  if (role === "admin") return true;
  if (role === "approver") {
    return section !== "admin";
  }
  // submitter
  return SUBMITTER_SECTIONS.has(section);
}

export type Section =
  | "dashboard"
  | "approvals"
  | "expenses"
  | "bills"
  | "receipts"
  | "transactions"
  | "programs"
  | "vendors"
  | "month-end"
  | "reports"
  | "admin";

const SUBMITTER_SECTIONS = new Set<Section>([
  "dashboard",
  "expenses",
  "bills",
  "receipts",
  "vendors",
]);

// --- Admin user-management helpers -----------------------------------------

export type AdminUserListItem = AuthUser & { isActive?: boolean };

export async function listUsers(): Promise<AuthUser[]> {
  const data = await apiJson<{ users: AuthUser[] }>("/admin/users");
  return data.users;
}

export async function createUser(input: {
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  password: string;
}): Promise<AuthUser> {
  const data = await apiJson<{ user: AuthUser }>("/admin/users", {
    method: "POST",
    body: input,
  });
  return data.user;
}

export async function changeUserPassword(
  userId: number,
  password: string,
): Promise<void> {
  await apiJson(`/admin/users/${userId}/password`, {
    method: "POST",
    body: { password },
  });
}
