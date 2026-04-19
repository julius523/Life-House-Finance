import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { AuthProvider, useAuth, canAccess, type Section } from "@/lib/auth";
import LoginPage from "@/pages/login";
import type { ComponentType, ReactNode } from "react";

// Import pages
import Dashboard from "@/pages/dashboard";
import Approvals from "@/pages/approvals";
import CopilotApprovalsPage from "@/pages/approvals-copilot";
import ExpensesList from "@/pages/expenses/index";
import ExpenseNew from "@/pages/expenses/new";
import ExpenseDetail from "@/pages/expenses/detail";
import ExpenseEdit from "@/pages/expenses/edit";
import BillsList from "@/pages/bills/index";
import BillNew from "@/pages/bills/new";
import BillEdit from "@/pages/bills/edit";
import BillDetail from "@/pages/bills/detail";
import ReceiptsList from "@/pages/receipts/index";
import TransactionsList from "@/pages/transactions/index";
import ProgramsList from "@/pages/programs/index";
import VendorsList from "@/pages/vendors/index";
import MonthEndList from "@/pages/month-end/index";
import MonthEndDetail from "@/pages/month-end/detail";
import ReportsPage from "@/pages/reports";
import AdminPage from "@/pages/admin";
import AdminExpenseCategoriesPage from "@/pages/admin-expense-categories";
import CreditsPage from "@/pages/credits";
import AccountingPage from "@/pages/accounting";
import AccountingCoaPage from "@/pages/accounting-coa";
import AccountingCoaDetail from "@/pages/accounting-coa-detail";
import AccountingSettingsPage from "@/pages/accounting-settings";
import AccountingBlockedExpensesPage from "@/pages/accounting-blocked-expenses";
import JournalEntriesNewPage from "@/pages/journal-entries-new";
import JournalEntriesListPage from "@/pages/journal-entries-list";
import JournalEntryDetailPage from "@/pages/journal-entries-detail";
import JournalEntryDraftDetailPage from "@/pages/journal-entry-draft-detail";

const queryClient = new QueryClient();

function Guard({
  section,
  children,
}: {
  section: Section;
  children: ReactNode;
}) {
  const { user } = useAuth();
  if (!canAccess(user?.role, section)) {
    return <Redirect to="/" />;
  }
  return <>{children}</>;
}

function route<TProps>(
  path: string,
  section: Section,
  Component: ComponentType<TProps>,
) {
  return (
    <Route
      key={path}
      path={path}
      component={(props: TProps) => (
        <Guard section={section}>
          <Component {...(props as TProps)} />
        </Guard>
      )}
    />
  );
}

function AppRoutes() {
  return (
    <Layout>
      <Switch>
        {route("/", "dashboard", Dashboard)}
        {route("/approvals", "approvals", Approvals)}
        {route("/approvals/copilot", "approvals", CopilotApprovalsPage)}

        {route("/expenses", "expenses", ExpensesList)}
        {route("/expenses/new", "expenses", ExpenseNew)}
        {route("/expenses/:id/edit", "expenses", ExpenseEdit)}
        {route("/expenses/:id", "expenses", ExpenseDetail)}

        {route("/bills", "bills", BillsList)}
        {route("/bills/new", "bills", BillNew)}
        {route("/bills/:id/edit", "bills", BillEdit)}
        {route("/bills/:id", "bills", BillDetail)}

        {route("/receipts", "receipts", ReceiptsList)}
        {route("/transactions", "transactions", TransactionsList)}
        {route("/programs", "programs", ProgramsList)}
        {route("/vendors", "vendors", VendorsList)}
        {route("/credits", "credits", CreditsPage)}
        {route("/month-end", "month-end", MonthEndList)}
        {route("/month-end/:id", "month-end", MonthEndDetail)}
        {route("/reports", "reports", ReportsPage)}
        {route("/accounting", "accounting", AccountingPage)}
        {route(
          "/accounting/journal-entries/new",
          "accounting",
          JournalEntriesNewPage,
        )}
        {route(
          "/accounting/journal-entries",
          "accounting",
          JournalEntriesListPage,
        )}
        {route(
          "/accounting/journal-entries/:id",
          "accounting",
          JournalEntryDetailPage,
        )}
        {route(
          "/accounting/journal-entry-drafts/:id",
          "accounting",
          JournalEntryDraftDetailPage,
        )}
        {route(
          "/accounting/blocked-expenses",
          "accounting",
          AccountingBlockedExpensesPage,
        )}
        {route("/accounting/coa", "accounting", AccountingCoaPage)}
        {route("/accounting/coa/:id", "accounting", AccountingCoaDetail)}
        {route("/accounting/settings", "accounting", AccountingSettingsPage)}
        {route("/admin", "admin", AdminPage)}
        {route(
          "/admin/expense-categories",
          "accounting",
          AdminExpenseCategoriesPage,
        )}

        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function RootRouter() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!user) {
    return (
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route>
          <Redirect to="/login" />
        </Route>
      </Switch>
    );
  }

  return (
    <Switch>
      <Route path="/login">
        <Redirect to="/" />
      </Route>
      <Route>
        <AppRoutes />
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthProvider>
            <RootRouter />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
