-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('IMAGE', 'GIF', 'AUDIO', 'SFX');

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('UPLOADING', 'UPLOADED', 'PROBING', 'TRANSCRIBING', 'READY', 'FAILED', 'LIVE');

-- CreateEnum
CREATE TYPE "ClipOrigin" AS ENUM ('AI_SUGGESTED', 'USER_CREATED');

-- CreateEnum
CREATE TYPE "AspectRatio" AS ENUM ('VERTICAL_9_16', 'SQUARE_1_1', 'LANDSCAPE_16_9', 'PORTRAIT_4_5');

-- CreateEnum
CREATE TYPE "SequenceTrackKind" AS ENUM ('VIDEO', 'AUDIO', 'OVERLAY');

-- CreateEnum
CREATE TYPE "SubtitlePreset" AS ENUM ('CLASSIC', 'BOLD', 'VIRAL', 'MINIMAL', 'KARAOKE');

-- CreateEnum
CREATE TYPE "CaptionAnimation" AS ENUM ('NONE', 'WORD_BY_WORD', 'POP', 'SCALE', 'BOUNCE', 'FADE', 'KARAOKE', 'SLIDE_UP', 'TYPEWRITER');

-- CreateEnum
CREATE TYPE "OverlayKind" AS ENUM ('TEXT', 'EMOJI', 'IMAGE');

-- CreateEnum
CREATE TYPE "RenderQuality" AS ENUM ('P720', 'P1080', 'ORIGINAL');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('PODCAST', 'INTERVIEW', 'GAMING', 'COMMENTARY', 'EDUCATIONAL', 'NEWS', 'VLOG', 'SHORT', 'LONGFORM', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FeedbackAction" AS ENUM ('ACCEPTED', 'REJECTED', 'MODIFIED');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'APPLIED');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('FETCH', 'PROBE', 'EXTRACT_AUDIO', 'TRANSCRIBE', 'ANALYZE', 'RENDER', 'THUMBNAIL', 'LIVE_TRANSCRIBE', 'LIVE_FINALIZE', 'TRANSLATE', 'AUDIO_FEATURES', 'WORKER_RUN', 'TRAIN_PROFILE', 'VOICEOVER');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "imageUrl" TEXT,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "text_presets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'caption',
    "style" TEXT NOT NULL,
    "animation" TEXT NOT NULL DEFAULT 'NONE',
    "wordRules" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "text_presets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "transcriptTerms" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "name" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "favoritedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_chunks" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "bytes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "videos" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "VideoStatus" NOT NULL DEFAULT 'UPLOADING',
    "originalFilename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "thumbnailKey" TEXT,
    "sourceUrl" TEXT,
    "sourceUrlHash" TEXT,
    "sizeBytes" BIGINT,
    "durationMs" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "fps" DOUBLE PRECISION,
    "videoCodec" TEXT,
    "audioCodec" TEXT,
    "audioChannels" INTEGER,
    "sampleRate" INTEGER,
    "hasAudio" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "contentType" "ContentType" NOT NULL DEFAULT 'UNKNOWN',
    "audioFeatureJson" TEXT,
    "liveHeartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "language" TEXT NOT NULL,
    "translatedTo" TEXT NOT NULL DEFAULT '',
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_segments" (
    "id" TEXT NOT NULL,
    "transcriptId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "speaker" TEXT,
    "confidence" DOUBLE PRECISION,

    CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_words" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,

    CONSTRAINT "transcript_words_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "caption_word_styles" (
    "id" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "wordId" TEXT NOT NULL,
    "color" TEXT,
    "bold" BOOLEAN,
    "italic" BOOLEAN,
    "sizeScale" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "caption_word_styles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clips" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "origin" "ClipOrigin" NOT NULL DEFAULT 'AI_SUGGESTED',
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "hook" TEXT,
    "description" TEXT,
    "reason" TEXT,
    "caption" TEXT,
    "socialTitle" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "score" DOUBLE PRECISION,
    "aspectRatio" "AspectRatio" NOT NULL DEFAULT 'VERTICAL_9_16',
    "focalX" DOUBLE PRECISION,
    "focalY" DOUBLE PRECISION,
    "censorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "censorSensitivity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "censorCaptionMode" TEXT NOT NULL DEFAULT 'FULL',
    "censorAudioEnabled" BOOLEAN NOT NULL DEFAULT true,
    "censorAudioMode" TEXT NOT NULL DEFAULT 'BEEP',
    "censorReplacement" TEXT,
    "censorAllowList" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "censorDenyList" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "censorExemptWordIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "censorForceWordIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "censorAudioExemptWordIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "censorAudioForceWordIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "censorWordOverridesJson" TEXT,
    "focusTrackJson" TEXT,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "playbackRate" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "removedWordIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "savedToProjectId" TEXT,
    "thumbnailKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequences" (
    "id" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 1080,
    "height" INTEGER NOT NULL DEFAULT 1920,
    "fps" INTEGER NOT NULL DEFAULT 30,
    "snap" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_tracks" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "kind" "SequenceTrackKind" NOT NULL DEFAULT 'VIDEO',
    "name" TEXT NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "sequence_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_items" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "sourceVideoId" TEXT,
    "sourceAssetId" TEXT,
    "timelineStart" INTEGER NOT NULL,
    "sourceIn" INTEGER NOT NULL DEFAULT 0,
    "sourceOut" INTEGER NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subtitle_configs" (
    "id" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "preset" "SubtitlePreset" NOT NULL DEFAULT 'CLASSIC',
    "fontFamily" TEXT NOT NULL DEFAULT 'Inter',
    "fontSizePx" INTEGER NOT NULL DEFAULT 64,
    "fontWeight" INTEGER NOT NULL DEFAULT 700,
    "textColor" TEXT NOT NULL DEFAULT '#FFFFFF',
    "highlightColor" TEXT NOT NULL DEFAULT '#FFE600',
    "outlineColor" TEXT NOT NULL DEFAULT '#000000',
    "outlineWidthPx" INTEGER NOT NULL DEFAULT 6,
    "shadowOpacity" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "backgroundColor" TEXT,
    "positionY" DOUBLE PRECISION NOT NULL DEFAULT 0.78,
    "alignment" TEXT NOT NULL DEFAULT 'center',
    "animation" "CaptionAnimation" NOT NULL DEFAULT 'NONE',
    "maxCharsPerLine" INTEGER NOT NULL DEFAULT 38,
    "maxLines" INTEGER NOT NULL DEFAULT 2,
    "maxWordsPerCue" INTEGER NOT NULL DEFAULT 7,
    "minCueMs" INTEGER NOT NULL DEFAULT 800,
    "maxCueMs" INTEGER NOT NULL DEFAULT 5000,
    "uppercase" BOOLEAN NOT NULL DEFAULT false,
    "styleJson" TEXT,
    "wordRulesJson" TEXT,

    CONSTRAINT "subtitle_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overlays" (
    "id" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "kind" "OverlayKind" NOT NULL,
    "content" TEXT NOT NULL,
    "assetId" TEXT,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "scale" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "opacity" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "startMs" INTEGER,
    "endMs" INTEGER,
    "zIndex" INTEGER NOT NULL DEFAULT 0,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "styleJson" TEXT,
    "animationJson" TEXT,
    "role" TEXT NOT NULL DEFAULT 'title',

    CONSTRAINT "overlays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renders" (
    "id" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "quality" "RenderQuality" NOT NULL DEFAULT 'P1080',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "outputKey" TEXT,
    "sizeBytes" BIGINT,
    "durationMs" INTEGER,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "renders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_examples" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clipId" TEXT,
    "contentType" "ContentType" NOT NULL DEFAULT 'UNKNOWN',
    "featureJson" JSONB NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_examples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "style_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contentType" "ContentType" NOT NULL,
    "profileJson" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "exampleCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "trainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "style_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suggestion_feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "videoId" TEXT,
    "kind" TEXT NOT NULL,
    "action" "FeedbackAction" NOT NULL,
    "suggestedJson" JSONB NOT NULL,
    "finalJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suggestion_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voiceovers" (
    "id" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL DEFAULT 'TRANSCRIPT',
    "script" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "voiceId" TEXT NOT NULL DEFAULT '',
    "speed" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "duckDb" DOUBLE PRECISION NOT NULL DEFAULT -60,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "linesJson" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voiceovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_runs" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "clipId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "objectivesJson" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "worker_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_suggestions" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "payloadJson" JSONB,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "createdClipId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "payload" JSONB,
    "result" JSONB,
    "errorMessage" TEXT,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "text_presets_userId_kind_idx" ON "text_presets"("userId", "kind");

-- CreateIndex
CREATE INDEX "projects_userId_updatedAt_idx" ON "projects"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "assets_storageKey_key" ON "assets"("storageKey");

-- CreateIndex
CREATE INDEX "assets_userId_createdAt_idx" ON "assets"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "live_chunks_storageKey_key" ON "live_chunks"("storageKey");

-- CreateIndex
CREATE INDEX "live_chunks_videoId_index_idx" ON "live_chunks"("videoId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "live_chunks_videoId_index_key" ON "live_chunks"("videoId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "videos_storageKey_key" ON "videos"("storageKey");

-- CreateIndex
CREATE INDEX "videos_projectId_createdAt_idx" ON "videos"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "videos_sourceUrlHash_idx" ON "videos"("sourceUrlHash");

-- CreateIndex
CREATE INDEX "videos_status_liveHeartbeatAt_idx" ON "videos"("status", "liveHeartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_videoId_translatedTo_key" ON "transcripts"("videoId", "translatedTo");

-- CreateIndex
CREATE INDEX "transcript_segments_transcriptId_startMs_idx" ON "transcript_segments"("transcriptId", "startMs");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_segments_transcriptId_index_key" ON "transcript_segments"("transcriptId", "index");

-- CreateIndex
CREATE INDEX "transcript_words_segmentId_startMs_idx" ON "transcript_words"("segmentId", "startMs");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_words_segmentId_index_key" ON "transcript_words"("segmentId", "index");

-- CreateIndex
CREATE INDEX "caption_word_styles_clipId_idx" ON "caption_word_styles"("clipId");

-- CreateIndex
CREATE UNIQUE INDEX "caption_word_styles_clipId_wordId_key" ON "caption_word_styles"("clipId", "wordId");

-- CreateIndex
CREATE INDEX "clips_videoId_startMs_idx" ON "clips"("videoId", "startMs");

-- CreateIndex
CREATE INDEX "clips_savedToProjectId_idx" ON "clips"("savedToProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "sequences_clipId_key" ON "sequences"("clipId");

-- CreateIndex
CREATE INDEX "sequence_tracks_sequenceId_idx" ON "sequence_tracks"("sequenceId");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_tracks_sequenceId_index_key" ON "sequence_tracks"("sequenceId", "index");

-- CreateIndex
CREATE INDEX "sequence_items_sequenceId_idx" ON "sequence_items"("sequenceId");

-- CreateIndex
CREATE INDEX "sequence_items_trackId_timelineStart_idx" ON "sequence_items"("trackId", "timelineStart");

-- CreateIndex
CREATE UNIQUE INDEX "subtitle_configs_clipId_key" ON "subtitle_configs"("clipId");

-- CreateIndex
CREATE INDEX "overlays_clipId_idx" ON "overlays"("clipId");

-- CreateIndex
CREATE INDEX "renders_clipId_createdAt_idx" ON "renders"("clipId", "createdAt");

-- CreateIndex
CREATE INDEX "training_examples_userId_contentType_createdAt_idx" ON "training_examples"("userId", "contentType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "style_profiles_userId_contentType_key" ON "style_profiles"("userId", "contentType");

-- CreateIndex
CREATE INDEX "suggestion_feedback_userId_kind_createdAt_idx" ON "suggestion_feedback"("userId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "voiceovers_clipId_idx" ON "voiceovers"("clipId");

-- CreateIndex
CREATE INDEX "worker_runs_videoId_createdAt_idx" ON "worker_runs"("videoId", "createdAt");

-- CreateIndex
CREATE INDEX "worker_suggestions_runId_status_idx" ON "worker_suggestions"("runId", "status");

-- CreateIndex
CREATE INDEX "jobs_status_runAfter_idx" ON "jobs"("status", "runAfter");

-- CreateIndex
CREATE INDEX "jobs_videoId_kind_idx" ON "jobs"("videoId", "kind");

-- AddForeignKey
ALTER TABLE "text_presets" ADD CONSTRAINT "text_presets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_chunks" ADD CONSTRAINT "live_chunks_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_words" ADD CONSTRAINT "transcript_words_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "transcript_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "caption_word_styles" ADD CONSTRAINT "caption_word_styles_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "caption_word_styles" ADD CONSTRAINT "caption_word_styles_wordId_fkey" FOREIGN KEY ("wordId") REFERENCES "transcript_words"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clips" ADD CONSTRAINT "clips_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clips" ADD CONSTRAINT "clips_savedToProjectId_fkey" FOREIGN KEY ("savedToProjectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_tracks" ADD CONSTRAINT "sequence_tracks_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_items" ADD CONSTRAINT "sequence_items_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_items" ADD CONSTRAINT "sequence_items_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "sequence_tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_items" ADD CONSTRAINT "sequence_items_sourceVideoId_fkey" FOREIGN KEY ("sourceVideoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sequence_items" ADD CONSTRAINT "sequence_items_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subtitle_configs" ADD CONSTRAINT "subtitle_configs_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overlays" ADD CONSTRAINT "overlays_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overlays" ADD CONSTRAINT "overlays_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_examples" ADD CONSTRAINT "training_examples_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_examples" ADD CONSTRAINT "training_examples_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "clips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_profiles" ADD CONSTRAINT "style_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestion_feedback" ADD CONSTRAINT "suggestion_feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voiceovers" ADD CONSTRAINT "voiceovers_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_runs" ADD CONSTRAINT "worker_runs_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_suggestions" ADD CONSTRAINT "worker_suggestions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "worker_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

