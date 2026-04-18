import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Receipt,
  FileText,
  FileBox,
  Landmark,
  FolderTree,
  Building2,
  CheckSquare,
  CalendarCheck,
  BarChart3,
  TrendingUp,
  Menu,
  Shield,
  Calculator,
  LogOut,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useAuth, canAccess, type Section } from "@/lib/auth";
import { NotificationBell } from "@/components/notification-bell";

const NAV_ITEMS: Array<{
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  section: Section;
}> = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, section: "dashboard" },
  { href: "/approvals", label: "Approvals", icon: CheckSquare, section: "approvals" },
  { href: "/expenses", label: "Expenses", icon: Receipt, section: "expenses" },
  { href: "/bills", label: "Bills", icon: FileText, section: "bills" },
  { href: "/receipts", label: "Receipts", icon: FileBox, section: "receipts" },
  { href: "/transactions", label: "Transactions", icon: Landmark, section: "transactions" },
  { href: "/programs", label: "Programs", icon: FolderTree, section: "programs" },
  { href: "/vendors", label: "Vendors", icon: Building2, section: "vendors" },
  { href: "/credits", label: "Credits & Deposits", icon: TrendingUp, section: "credits" },
  { href: "/month-end", label: "Month End", icon: CalendarCheck, section: "month-end" },
  { href: "/reports", label: "Reports", icon: BarChart3, section: "reports" },
  { href: "/accounting", label: "Accounting", icon: Calculator, section: "accounting" },
  { href: "/admin", label: "Admin", icon: Shield, section: "admin" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, logout } = useAuth();

  const visible = NAV_ITEMS.filter((item) => canAccess(user?.role, item.section));

  const SidebarContent = () => (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="p-6">
        <h2 className="text-xl font-bold tracking-tight text-sidebar-primary-foreground">
          Life House
        </h2>
        <p className="text-sm font-medium text-sidebar-primary-foreground/70">
          Finance Portal
        </p>
      </div>
      <nav className="flex-1 space-y-1 px-4 py-2 overflow-y-auto">
        {visible.map((item) => {
          const isActive =
            location === item.href ||
            (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
            >
              <div
                className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                    : "text-sidebar-foreground/80"
                }`}
              >
                <item.icon className="h-5 w-5" />
                {item.label}
              </div>
            </Link>
          );
        })}
      </nav>
      {user && (
        <div className="p-4 border-t border-sidebar-border/50 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="text-sm min-w-0">
              <p className="font-semibold text-sidebar-foreground truncate">
                {user.firstName} {user.lastName}
              </p>
              <p className="text-xs text-sidebar-foreground/70 truncate">
                {user.email}
              </p>
              <p className="text-[10px] uppercase tracking-wide text-sidebar-foreground/60 mt-0.5">
                {user.role}
              </p>
            </div>
            <NotificationBell />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-sidebar-foreground/80 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent"
            onClick={() => {
              setMobileOpen(false);
              logout();
            }}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-screen w-full flex-col md:flex-row bg-background">
      {/* Mobile Header */}
      <div className="flex h-16 items-center justify-between border-b bg-sidebar px-4 md:hidden">
        <div className="flex flex-col">
          <h2 className="text-lg font-bold text-sidebar-primary-foreground">
            Life House
          </h2>
        </div>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-sidebar-primary-foreground"
            >
              <Menu className="h-6 w-6" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0 border-r-0">
            <SidebarContent />
          </SheetContent>
        </Sheet>
      </div>

      {/* Desktop Sidebar */}
      <div className="hidden w-64 flex-shrink-0 md:block border-r border-sidebar-border">
        <SidebarContent />
      </div>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl p-4 md:p-8">{children}</div>
      </main>
    </div>
  );
}
