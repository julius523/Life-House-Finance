import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import expensesRouter from "./expenses";
import vendorsRouter from "./vendors";
import billsRouter from "./bills";
import receiptsRouter from "./receipts";
import transactionsRouter from "./transactions";
import programsRouter from "./programs";
import approvalsRouter from "./approvals";
import monthEndRouter from "./month-end";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.use(expensesRouter);
router.use(vendorsRouter);
router.use(billsRouter);
router.use(receiptsRouter);
router.use(transactionsRouter);
router.use(programsRouter);
router.use(approvalsRouter);
router.use(monthEndRouter);

export default router;
