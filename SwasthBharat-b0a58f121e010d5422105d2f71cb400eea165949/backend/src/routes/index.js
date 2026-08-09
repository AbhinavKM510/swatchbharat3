/** Mounts every API router under /api. */

import express from 'express';
import { assessmentsRouter } from './assessments.routes.js';
import { authRouter } from './auth.routes.js';
import { chatbotRouter } from './chatbot.routes.js';
import { dashboardRouter } from './dashboard.routes.js';
import { districtRouter } from './district.routes.js';
import { metaRouter } from './meta.routes.js';
import { notificationsRouter } from './notifications.routes.js';
import { patientsRouter } from './patients.routes.js';
import { teleconsultRouter } from './teleconsult.routes.js';

export const apiRouter = express.Router();

apiRouter.use('/', metaRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/patients', patientsRouter);
apiRouter.use('/assessments', assessmentsRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/district', districtRouter);
apiRouter.use('/chatbot', chatbotRouter);
apiRouter.use('/teleconsult', teleconsultRouter);
apiRouter.use('/notifications', notificationsRouter);
