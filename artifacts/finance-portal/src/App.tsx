import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";

// Import pages
import Dashboard from "@/pages/dashboard";
import Approvals from "@/pages/approvals";
import ExpensesList from "@/pages/expenses/index";
import ExpenseNew from "@/pages/expenses/new";
import ExpenseDetail from "@/pages/expenses/detail";
import BillsList from "@/pages/bills/index";
import BillNew from "@/pages/bills/new";
import BillDetail from "@/pages/bills/detail";
import ReceiptsList from "@/pages/receipts/index";
import TransactionsList from "@/pages/transactions/index";
import ProgramsList from "@/pages/programs/index";
import VendorsList from "@/pages/vendors/index";
import MonthEndList from "@/pages/month-end/index";
import MonthEndDetail from "@/pages/month-end/detail";
import ReportsPage from "@/pages/reports";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/approvals" component={Approvals} />
        
        <Route path="/expenses" component={ExpensesList} />
        <Route path="/expenses/new" component={ExpenseNew} />
        <Route path="/expenses/:id" component={ExpenseDetail} />
        
        <Route path="/bills" component={BillsList} />
        <Route path="/bills/new" component={BillNew} />
        <Route path="/bills/:id" component={BillDetail} />
        
        <Route path="/receipts" component={ReceiptsList} />
        <Route path="/transactions" component={TransactionsList} />
        <Route path="/programs" component={ProgramsList} />
        <Route path="/vendors" component={VendorsList} />
        <Route path="/month-end" component={MonthEndList} />
        <Route path="/month-end/:id" component={MonthEndDetail} />
        <Route path="/reports" component={ReportsPage} />

        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
