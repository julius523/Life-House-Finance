import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  login as apiLogin,
  logout as apiLogout,
  getCurrentUser,
  listAdminUsers,
  createAdminUser,
  changeAdminUserPassword,
  type AuthUser as ApiAuthUser,
  type AuthUserRole,
} from "@workspace/api-client-react";

export type UserRole = AuthUserRole;
export type AuthUser = ApiAuthUser;

type AuthState = {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const data = await getCurrentUser();
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
    const data = await apiLogin({ email, password });
    setUser(data.user);
  };

  const logout = async () => {
    try {
      await apiLogout();
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
  | "credits"
  | "month-end"
  | "reports"
  | "accounting"
  | "admin";

const SUBMITTER_SECTIONS = new Set<Section>([
  "dashboard",
  "expenses",
  "bills",
  "receipts",
  "vendors",
  "accounting",
]);

// --- Admin user-management helpers -----------------------------------------

export type AdminUserListItem = AuthUser & { isActive?: boolean };

export async function listUsers(): Promise<AuthUser[]> {
  const data = await listAdminUsers();
  return data.users;
}

export async function createUser(input: {
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  password: string;
}): Promise<AuthUser> {
  const data = await createAdminUser(input);
  return data.user;
}

export async function changeUserPassword(
  userId: number,
  password: string,
): Promise<void> {
  await changeAdminUserPassword(userId, { password });
}
