-- CreateTable
CREATE TABLE "survey_questions" (
    "id" SERIAL NOT NULL,
    "module" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "options" TEXT NOT NULL,
    "hasFree" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "survey_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_responses" (
    "id" SERIAL NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "questionId1" INTEGER NOT NULL,
    "questionId2" INTEGER NOT NULL,
    "answer1" TEXT,
    "answer2" TEXT,
    "free1" TEXT,
    "free2" TEXT,
    "currentStep" INTEGER NOT NULL DEFAULT 1,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "survey_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "survey_questions_module_idx" ON "survey_questions"("module");

-- CreateIndex
CREATE INDEX "survey_questions_isActive_idx" ON "survey_questions"("isActive");

-- CreateIndex
CREATE INDEX "survey_responses_lineUserId_idx" ON "survey_responses"("lineUserId");

-- CreateIndex
CREATE INDEX "survey_responses_scheduleId_idx" ON "survey_responses"("scheduleId");

-- CreateIndex
CREATE INDEX "survey_responses_currentStep_idx" ON "survey_responses"("currentStep");
