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
  Menu
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/approvals", label: "Approvals", icon: CheckSquare },
  { href: "/expenses", label: "Expenses", icon: Receipt },
  { href: "/bills", label: "Bills", icon: FileText },
  { href: "/receipts", label: "Receipts", icon: FileBox },
  { href: "/transactions", label: "Transactions", icon: Landmark },
  { href: "/programs", label: "Programs", icon: FolderTree },
  { href: "/vendors", label: "Vendors", icon: Building2 },
  { href: "/month-end", label: "Month End", icon: CalendarCheck },
  { href: "/reports", label: "Reports", icon: BarChart3 },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

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
      <nav className="flex-1 space-y-1 px-4 py-2">
        {NAV_ITEMS.map((item) => {
          const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href} onClick={() => setMobileOpen(false)}>
              <div
                className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${
                  isActive ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm" : "text-sidebar-foreground/80"
                }`}
              >
                <item.icon className="h-5 w-5" />
                {item.label}
              </div>
            </Link>
          );
        })}
      </nav>
      <div className="p-4">
        <div className="rounded-lg bg-sidebar-accent/50 p-4 text-sm">
          <p className="font-semibold text-sidebar-foreground">Need help?</p>
          <p className="text-sidebar-foreground/70 mt-1 text-xs">Contact the admin team for support.</p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen w-full flex-col md:flex-row bg-background">
      {/* Mobile Header */}
      <div className="flex h-16 items-center justify-between border-b bg-sidebar px-4 md:hidden">
        <div className="flex flex-col">
           <h2 className="text-lg font-bold text-sidebar-primary-foreground">Life House</h2>
        </div>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="text-sidebar-primary-foreground">
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
        <div className="mx-auto max-w-6xl p-4 md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
