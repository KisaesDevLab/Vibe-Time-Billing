DO $$ BEGIN
 CREATE TYPE "adjustment_allocation_method" AS ENUM('SPECIFIC_ENTRIES', 'PRO_RATA_BY_VALUE', 'PRO_RATA_BY_HOURS', 'PARTNER_ABSORBS', 'HIERARCHICAL_CASCADE', 'CUSTOM_WEIGHTED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "adjustment_method" AS ENUM('RATE', 'TIME', 'FEE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "adjustment_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'APPLIED', 'REVERSED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "ai_provider" AS ENUM('LOCAL_OLLAMA', 'LOCAL_LLAMACPP', 'ANTHROPIC', 'OPENAI_COMPATIBLE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "approval_entity_type" AS ENUM('ADJUSTMENT', 'PRE_BILL', 'INVOICE', 'ENGAGEMENT_LETTER', 'RATE_CHANGE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "approval_status" AS ENUM('PENDING', 'APPROVED', 'APPROVED_WITH_EDITS', 'REJECTED', 'CANCELLED', 'AUTO_ESCALATED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "audit_action" AS ENUM('CREATE', 'UPDATE', 'ARCHIVE', 'RESTORE', 'LOGIN', 'LOGOUT', 'STEP_UP', 'EXPORT', 'IMPERSONATE', 'PAYMENT', 'WEBHOOK_DELIVERY', 'MCP_CALL', 'AI_REQUEST', 'BACKUP', 'RESTORE_DATABASE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "billing_batch_entry_action" AS ENUM('INCLUDE', 'DEFER', 'WRITE_OFF');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "billing_batch_status" AS ENUM('DRAFT', 'IN_REVIEW', 'APPROVED', 'INVOICED', 'CANCELLED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "consolidation_preference" AS ENUM('CONSOLIDATED', 'SEPARATE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "engagement_status" AS ENUM('PROPOSED', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "entity_status" AS ENUM('PROSPECT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "fee_structure" AS ENUM('HOURLY', 'HOURLY_NTE', 'FIXED_FEE', 'FIXED_FEE_WITH_MILESTONES', 'RECURRING_SUBSCRIPTION');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "hour_bank_transaction_type" AS ENUM('PURCHASE', 'DEBIT', 'EXPIRE', 'FORFEIT', 'REFUND');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "invoice_line_item_kind" AS ENUM('TIME_AGGREGATE', 'FIXED_FEE', 'MILESTONE', 'RECURRING_FEE', 'EXPENSE', 'PROCESSING_FEE', 'CUSTOM');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "invoice_status" AS ENUM('DRAFT', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOIDED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "milestone_status" AS ENUM('PENDING', 'TRIGGERED', 'INVOICED', 'CANCELLED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "milestone_trigger_type" AS ENUM('DATE', 'EVENT', 'MANUAL');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "office_role" AS ENUM('PARTNER', 'MANAGER', 'SENIOR', 'STAFF', 'ADMIN');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "payment_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "reason_code_category" AS ENUM('WRITE_DOWN', 'WRITE_UP', 'TRANSFER');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "recurring_frequency" AS ENUM('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "recurring_plan_status" AS ENUM('ACTIVE', 'PAUSED', 'CANCELLED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "service_line_category" AS ENUM('tax', 'audit', 'advisory', 'bookkeeping', 'payroll');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "time_entry_status" AS ENUM('DRAFT', 'SUBMITTED', 'LOCKED', 'BILLED', 'WRITTEN_OFF', 'ARCHIVED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "user_status" AS ENUM('ACTIVE', 'INACTIVE', 'ARCHIVED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "webhook_delivery_status" AS ENUM('PENDING', 'DELIVERED', 'FAILED', 'GAVE_UP');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "payment_method_kind" AS ENUM('CARD', 'ACH');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "payment_method_status" AS ENUM('ACTIVE', 'EXPIRED', 'REVOKED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "payment_provider" AS ENUM('STRIPE', 'CPACHARGE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "portal_access_role" AS ENUM('FULL', 'VIEW_ONLY', 'PAY_ONLY');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "portal_access_status" AS ENUM('INVITED', 'ACTIVE', 'INACTIVE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "portal_channel" AS ENUM('EMAIL', 'SMS');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "portal_login_method" AS ENUM('EMAIL', 'SMS');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "token_status" AS ENUM('ACTIVE', 'USED', 'EXPIRED', 'REVOKED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "adjustment_allocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"time_entry_id" uuid NOT NULL,
	"app_user_id" uuid NOT NULL,
	"original_value_cents" bigint NOT NULL,
	"adjusted_value_cents" bigint NOT NULL,
	"adjustment_amount_cents" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "adjustment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_batch_id" uuid NOT NULL,
	"method" "adjustment_method" NOT NULL,
	"allocation_method" "adjustment_allocation_method" NOT NULL,
	"total_amount_cents" bigint NOT NULL,
	"reason_code_id" uuid NOT NULL,
	"notes" text,
	"status" "adjustment_status" DEFAULT 'DRAFT' NOT NULL,
	"created_by_id" uuid NOT NULL,
	"approver_id" uuid,
	"approved_at" timestamp with time zone,
	"reversed_by_id" uuid,
	"reversed_at" timestamp with time zone,
	"custom_weighted_input_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_request_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"provider" "ai_provider" NOT NULL,
	"model" text NOT NULL,
	"feature" text NOT NULL,
	"request_tokens" integer,
	"response_tokens" integer,
	"cost_cents" integer,
	"latency_ms" integer,
	"success" boolean NOT NULL,
	"error_message" text,
	"app_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"default_office_id" uuid,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"totp_secret_encrypted" text,
	"totp_enrolled_at" timestamp with time zone,
	"recovery_codes_encrypted" text,
	"standard_hours_per_week" numeric(5, 2) DEFAULT '40.00' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid,
	"entity_type" "approval_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"approver_id" uuid,
	"status" "approval_status" DEFAULT 'PENDING' NOT NULL,
	"comments" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"due_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"entity_type" "approval_entity_type" NOT NULL,
	"name" text NOT NULL,
	"conditions_json" jsonb NOT NULL,
	"approver_resolution_json" jsonb NOT NULL,
	"sla_hours" integer,
	"auto_escalate_hours" integer,
	"priority" integer DEFAULT 100 NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_app_user_id" uuid,
	"actor_portal_identity_id" uuid,
	"actor_mcp_token_id" uuid,
	"active_client_id" uuid,
	"action" "audit_action" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before_json" jsonb,
	"after_json" jsonb,
	"ip" text,
	"user_agent" text,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_batch_entry" (
	"billing_batch_id" uuid NOT NULL,
	"time_entry_id" uuid NOT NULL,
	"action" "billing_batch_entry_action" DEFAULT 'INCLUDE' NOT NULL,
	"comment" text,
	CONSTRAINT "billing_batch_entry_billing_batch_id_time_entry_id_pk" PRIMARY KEY("billing_batch_id","time_entry_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" "billing_batch_status" DEFAULT 'DRAFT' NOT NULL,
	"created_by_id" uuid,
	"approved_by_id" uuid,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_rate_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"app_user_id" uuid NOT NULL,
	"bill_rate_cents" bigint NOT NULL,
	"effective_start" date NOT NULL,
	"effective_end" date
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"partner_in_charge_id" uuid NOT NULL,
	"billing_contact_name" text,
	"billing_contact_email" text,
	"billing_contact_phone" text,
	"billing_address" text,
	"terms_days" integer DEFAULT 30 NOT NULL,
	"invoice_consolidation_preference" "consolidation_preference" DEFAULT 'SEPARATE' NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "engagement_rate_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"app_user_id" uuid NOT NULL,
	"bill_rate_cents" bigint NOT NULL,
	"effective_start" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "engagement_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"service_line_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"default_fee_structure" "fee_structure",
	"default_budget_hours" numeric(8, 2),
	"auto_rollover_default" boolean DEFAULT false NOT NULL,
	"template_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "engagement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"engagement_type_id" uuid,
	"name" text NOT NULL,
	"fee_structure" "fee_structure" NOT NULL,
	"fee_amount_cents" bigint,
	"budget_hours" numeric(8, 2),
	"budget_amount_cents" bigint,
	"mixed_mode_enabled" boolean DEFAULT false NOT NULL,
	"in_scope_work_code_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"nte_cap_cents" bigint,
	"nte_cap_scope" text,
	"fee_passthrough_enabled" boolean DEFAULT false NOT NULL,
	"partner_id" uuid,
	"manager_id" uuid,
	"scope_definition" text,
	"status" "engagement_status" DEFAULT 'PROPOSED' NOT NULL,
	"start_date" date,
	"end_date" date,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"auto_rollover_enabled" boolean DEFAULT false NOT NULL,
	"auto_rollover_price_increase_pct" numeric(5, 2),
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "firm_settings" (
	"firm_id" uuid PRIMARY KEY NOT NULL,
	"adjustment_approval_threshold_cents" bigint DEFAULT 100000 NOT NULL,
	"ai_monthly_budget_cents" bigint DEFAULT 10000 NOT NULL,
	"ai_warn_threshold_pct" integer DEFAULT 80 NOT NULL,
	"time_entry_rounding_hours" numeric(4, 2) DEFAULT '0.25' NOT NULL,
	"step_up_timeout_minutes" integer DEFAULT 30 NOT NULL,
	"late_entry_alert_days" integer DEFAULT 3 NOT NULL,
	"late_entry_lockout_days" integer DEFAULT 14 NOT NULL,
	"invoice_numbering_prefix" text DEFAULT 'INV' NOT NULL,
	"portal_enabled" boolean DEFAULT true NOT NULL,
	"portal_subdomain" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "firm" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"fiscal_year_start_month" integer DEFAULT 1 NOT NULL,
	"default_allocation_method" "adjustment_allocation_method" DEFAULT 'PRO_RATA_BY_VALUE' NOT NULL,
	"default_terms_days" integer DEFAULT 30 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hour_bank_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hour_bank_id" uuid NOT NULL,
	"type" "hour_bank_transaction_type" NOT NULL,
	"hours" numeric(8, 2) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"source_ref_type" text,
	"source_ref_id" uuid,
	"running_balance_hours" numeric(10, 2) NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hour_bank" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"opening_hours" numeric(8, 2) NOT NULL,
	"opening_amount_cents" bigint NOT NULL,
	"rollover_cap_hours" numeric(8, 2),
	"expiration_date" date,
	"forfeited_at" timestamp with time zone,
	"forfeited_amount_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hour_bank_engagement_id_unique" UNIQUE("engagement_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_line_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"kind" "invoice_line_item_kind" NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(10, 2),
	"rate_cents" bigint,
	"amount_cents" bigint NOT NULL,
	"engagement_id" uuid,
	"source_ref_type" text,
	"source_ref_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"primary_engagement_id" uuid,
	"invoice_number" text NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"fee_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint NOT NULL,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"sent_at" timestamp with time zone,
	"first_viewed_at" timestamp with time zone,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_reason" text,
	"notes" text,
	"pay_to_unlock_attachments" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"allowed_tools" jsonb NOT NULL,
	"created_by_id" uuid,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "milestone_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"total_fee_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestone_plan_engagement_id_unique" UNIQUE("engagement_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "milestone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"name" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"sequence" integer NOT NULL,
	"trigger_type" "milestone_trigger_type" NOT NULL,
	"trigger_date" date,
	"trigger_event_key" text,
	"invoice_id" uuid,
	"status" "milestone_status" DEFAULT 'PENDING' NOT NULL,
	"triggered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "office" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"fee_cents" bigint DEFAULT 0 NOT NULL,
	"payment_method_id" uuid,
	"provider" text NOT NULL,
	"provider_charge_id" text,
	"status" "payment_status" NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"refunded_at" timestamp with time zone,
	"refunded_amount_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reason_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"category" "reason_code_category" NOT NULL,
	"label" text NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recurring_billing_plan_service" (
	"plan_id" uuid NOT NULL,
	"service_line_id" uuid NOT NULL,
	"included_hours" numeric(8, 2),
	CONSTRAINT "recurring_billing_plan_service_plan_id_service_line_id_pk" PRIMARY KEY("plan_id","service_line_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recurring_billing_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"frequency" "recurring_frequency" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"billing_day_of_month" integer,
	"next_run_date" date NOT NULL,
	"auto_pay_flag" boolean DEFAULT false NOT NULL,
	"auto_pay_payment_method_id" uuid,
	"proration_rule" text DEFAULT 'DAILY' NOT NULL,
	"status" "recurring_plan_status" DEFAULT 'ACTIVE' NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_permission" (
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	CONSTRAINT "role_permission_role_id_permission_key_pk" PRIMARY KEY("role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"system_flag" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_line_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_line_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"bill_rate_cents" bigint NOT NULL,
	"effective_start" date NOT NULL,
	"effective_end" date
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" "service_line_category" NOT NULL,
	"color" text,
	"icon" text,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "time_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"app_user_id" uuid NOT NULL,
	"work_code_id" uuid,
	"entry_date" date NOT NULL,
	"hours" numeric(6, 2) NOT NULL,
	"billable_flag" boolean DEFAULT true NOT NULL,
	"in_scope_flag" boolean DEFAULT true NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"standard_rate_snapshot_cents" bigint NOT NULL,
	"standard_amount_cents" bigint NOT NULL,
	"status" "time_entry_status" DEFAULT 'SUBMITTED' NOT NULL,
	"billing_batch_id" uuid,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "time_entry_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"time_entry_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"fields" jsonb NOT NULL,
	"edited_by_id" uuid,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timekeeper_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_user_id" uuid NOT NULL,
	"bill_rate_cents" bigint NOT NULL,
	"cost_rate_cents" bigint,
	"effective_start" date NOT NULL,
	"effective_end" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_role" (
	"app_user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "user_role_app_user_id_role_id_pk" PRIMARY KEY("app_user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_endpoint_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"response_status" integer,
	"response_body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_endpoint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret_hash" text NOT NULL,
	"events" jsonb NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"service_line_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"billable_default" boolean DEFAULT true NOT NULL,
	"description_template" text,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "client_portal_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_identity_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"role" "portal_access_role" DEFAULT 'FULL' NOT NULL,
	"notification_preferences" jsonb DEFAULT '{"newInvoice":["EMAIL"],"paymentConfirmation":["EMAIL"],"paymentFailed":["EMAIL","SMS"],"documentReady":["EMAIL"],"autoPayUpcoming":[],"statementMonthly":["EMAIL"]}'::jsonb NOT NULL,
	"status" "portal_access_status" DEFAULT 'INVITED' NOT NULL,
	"invited_by" uuid,
	"invited_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_identity_id" uuid NOT NULL,
	"kind" "payment_method_kind" NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_token" text NOT NULL,
	"provider_customer_id" text,
	"last_four" text NOT NULL,
	"display_label" text NOT NULL,
	"brand" text,
	"exp_month" integer,
	"exp_year" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" "payment_method_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_auth_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"channel" "portal_channel" NOT NULL,
	"contact_value" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" "token_status" DEFAULT 'ACTIVE' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"ip" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_auth_challenge_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"primary_email" text,
	"primary_email_verified_at" timestamp with time zone,
	"primary_phone" text,
	"primary_phone_verified_at" timestamp with time zone,
	"preferred_method" "portal_login_method" DEFAULT 'EMAIL' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"last_login_at" timestamp with time zone,
	"last_login_channel" "portal_channel",
	"last_login_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firm_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"portal_identity_id" uuid,
	"invited_email" text,
	"invited_phone" text,
	"proposed_full_name" text NOT NULL,
	"proposed_role" "portal_access_role" DEFAULT 'FULL' NOT NULL,
	"proposed_notification_preferences" jsonb DEFAULT '{"newInvoice":["EMAIL"],"paymentConfirmation":["EMAIL"],"paymentFailed":["EMAIL","SMS"],"documentReady":["EMAIL"],"autoPayUpcoming":[],"statementMonthly":["EMAIL"]}'::jsonb NOT NULL,
	"delivery_channel" "portal_channel" NOT NULL,
	"token_hash" text NOT NULL,
	"status" "token_status" DEFAULT 'ACTIVE' NOT NULL,
	"invited_by" uuid NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_invitation_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_identity_id" uuid NOT NULL,
	"active_client_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_session_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adjustment_allocation_adjustment_idx" ON "adjustment_allocation" ("adjustment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adjustment_allocation_time_entry_idx" ON "adjustment_allocation" ("time_entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adjustment_allocation_user_idx" ON "adjustment_allocation" ("app_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "adjustment_allocation_natural_uk" ON "adjustment_allocation" ("adjustment_id","time_entry_id","app_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adjustment_batch_idx" ON "adjustment" ("billing_batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adjustment_status_idx" ON "adjustment" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adjustment_reason_idx" ON "adjustment" ("reason_code_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_request_log_firm_month_idx" ON "ai_request_log" ("firm_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_user_firm_email_uk" ON "app_user" ("firm_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_user_firm_idx" ON "app_user" ("firm_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_user_status_idx" ON "app_user" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_request_entity_idx" ON "approval_request" ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_request_approver_status_idx" ON "approval_request" ("approver_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_rule_firm_entity_idx" ON "approval_rule" ("firm_id","entity_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_occurred_at_idx" ON "audit_log" ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_entity_idx" ON "audit_log" ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_actor_app_user_idx" ON "audit_log" ("actor_app_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_actor_portal_idx" ON "audit_log" ("actor_portal_identity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_batch_entry_time_entry_idx" ON "billing_batch_entry" ("time_entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_batch_engagement_period_idx" ON "billing_batch" ("engagement_id","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_batch_status_idx" ON "billing_batch" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_rate_override_client_user_idx" ON "client_rate_override" ("client_id","app_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_firm_idx" ON "client" ("firm_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_status_idx" ON "client" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_partner_idx" ON "client" ("partner_in_charge_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_name_search_idx" ON "client" ("firm_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "engagement_rate_override_eng_user_idx" ON "engagement_rate_override" ("engagement_id","app_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "engagement_type_firm_key_uk" ON "engagement_type" ("firm_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "engagement_client_idx" ON "engagement" ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "engagement_status_idx" ON "engagement" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "engagement_partner_idx" ON "engagement" ("partner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "engagement_fee_structure_idx" ON "engagement" ("fee_structure");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hour_bank_tx_bank_occurred_idx" ON "hour_bank_transaction" ("hour_bank_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_line_item_invoice_idx" ON "invoice_line_item" ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_firm_number_uk" ON "invoice" ("firm_id","invoice_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_client_idx" ON "invoice" ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_status_idx" ON "invoice" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_due_date_idx" ON "invoice" ("due_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "milestone_plan_sequence_idx" ON "milestone" ("plan_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "milestone_status_idx" ON "milestone" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "office_firm_idx" ON "office" ("firm_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_invoice_idx" ON "payment" ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_provider_charge_idx" ON "payment" ("provider_charge_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reason_code_firm_cat_label_uk" ON "reason_code" ("firm_id","category","label");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recurring_plan_engagement_idx" ON "recurring_billing_plan" ("engagement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recurring_plan_next_run_idx" ON "recurring_billing_plan" ("next_run_date","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "role_firm_name_uk" ON "role" ("firm_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_line_firm_idx" ON "service_line" ("firm_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_entry_engagement_idx" ON "time_entry" ("engagement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_entry_user_date_idx" ON "time_entry" ("app_user_id","entry_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_entry_date_idx" ON "time_entry" ("entry_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_entry_status_idx" ON "time_entry" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_entry_batch_idx" ON "time_entry" ("billing_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "time_entry_version_entry_version_uk" ON "time_entry_version" ("time_entry_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timekeeper_rate_user_effective_idx" ON "timekeeper_rate" ("app_user_id","effective_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_delivery_status_idx" ON "webhook_delivery" ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_code_firm_key_uk" ON "work_code" ("firm_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_code_service_line_idx" ON "work_code" ("service_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "client_portal_access_identity_client_uk" ON "client_portal_access" ("portal_identity_id","client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_portal_access_client_idx" ON "client_portal_access" ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_portal_access_status_idx" ON "client_portal_access" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_method_identity_idx" ON "payment_method" ("portal_identity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_method_identity_default_idx" ON "payment_method" ("portal_identity_id","is_default");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_method_status_idx" ON "payment_method" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_auth_challenge_contact_status_idx" ON "portal_auth_challenge" ("contact_value","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_auth_challenge_expires_idx" ON "portal_auth_challenge" ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_auth_challenge_firm_idx" ON "portal_auth_challenge" ("firm_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_identity_firm_email_uk" ON "portal_identity" ("firm_id","primary_email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_identity_firm_phone_uk" ON "portal_identity" ("firm_id","primary_phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_identity_firm_idx" ON "portal_identity" ("firm_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_invitation_client_idx" ON "portal_invitation" ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_invitation_email_idx" ON "portal_invitation" ("invited_email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_invitation_phone_idx" ON "portal_invitation" ("invited_phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_invitation_status_idx" ON "portal_invitation" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_session_identity_idx" ON "portal_session" ("portal_identity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_session_expires_idx" ON "portal_session" ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_session_activity_idx" ON "portal_session" ("last_activity_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adjustment_allocation" ADD CONSTRAINT "adjustment_allocation_adjustment_id_adjustment_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "adjustment"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adjustment_allocation" ADD CONSTRAINT "adjustment_allocation_time_entry_id_time_entry_id_fk" FOREIGN KEY ("time_entry_id") REFERENCES "time_entry"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adjustment_allocation" ADD CONSTRAINT "adjustment_allocation_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_billing_batch_id_billing_batch_id_fk" FOREIGN KEY ("billing_batch_id") REFERENCES "billing_batch"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_reason_code_id_reason_code_id_fk" FOREIGN KEY ("reason_code_id") REFERENCES "reason_code"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_created_by_id_app_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_approver_id_app_user_id_fk" FOREIGN KEY ("approver_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_reversed_by_id_app_user_id_fk" FOREIGN KEY ("reversed_by_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_request_log" ADD CONSTRAINT "ai_request_log_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_request_log" ADD CONSTRAINT "ai_request_log_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_user" ADD CONSTRAINT "app_user_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_user" ADD CONSTRAINT "app_user_default_office_id_office_id_fk" FOREIGN KEY ("default_office_id") REFERENCES "office"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_rule_id_approval_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "approval_rule"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_requester_id_app_user_id_fk" FOREIGN KEY ("requester_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_approver_id_app_user_id_fk" FOREIGN KEY ("approver_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_rule" ADD CONSTRAINT "approval_rule_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_app_user_id_app_user_id_fk" FOREIGN KEY ("actor_app_user_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_active_client_id_client_id_fk" FOREIGN KEY ("active_client_id") REFERENCES "client"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_batch_entry" ADD CONSTRAINT "billing_batch_entry_billing_batch_id_billing_batch_id_fk" FOREIGN KEY ("billing_batch_id") REFERENCES "billing_batch"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_batch_entry" ADD CONSTRAINT "billing_batch_entry_time_entry_id_time_entry_id_fk" FOREIGN KEY ("time_entry_id") REFERENCES "time_entry"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_batch" ADD CONSTRAINT "billing_batch_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "engagement"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_batch" ADD CONSTRAINT "billing_batch_created_by_id_app_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "billing_batch" ADD CONSTRAINT "billing_batch_approved_by_id_app_user_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_rate_override" ADD CONSTRAINT "client_rate_override_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_rate_override" ADD CONSTRAINT "client_rate_override_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client" ADD CONSTRAINT "client_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client" ADD CONSTRAINT "client_partner_in_charge_id_app_user_id_fk" FOREIGN KEY ("partner_in_charge_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "engagement_rate_override" ADD CONSTRAINT "engagement_rate_override_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "engagement"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "engagement_rate_override" ADD CONSTRAINT "engagement_rate_override_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "engagement_type" ADD CONSTRAINT "engagement_type_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "engagement_type" ADD CONSTRAINT "engagement_type_service_line_id_service_line_id_fk" FOREIGN KEY ("service_line_id") REFERENCES "service_line"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "engagement" ADD CONSTRAINT "engagement_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "engagement" ADD CONSTRAINT "engagement_engagement_type_id_engagement_type_id_fk" FOREIGN KEY ("engagement_type_id") REFERENCES "engagement_type"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "engagement" ADD CONSTRAINT "engagement_partner_id_app_user_id_fk" FOREIGN KEY ("partner_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "engagement" ADD CONSTRAINT "engagement_manager_id_app_user_id_fk" FOREIGN KEY ("manager_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "firm_settings" ADD CONSTRAINT "firm_settings_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hour_bank_transaction" ADD CONSTRAINT "hour_bank_transaction_hour_bank_id_hour_bank_id_fk" FOREIGN KEY ("hour_bank_id") REFERENCES "hour_bank"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hour_bank" ADD CONSTRAINT "hour_bank_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "engagement"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_line_item" ADD CONSTRAINT "invoice_line_item_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_line_item" ADD CONSTRAINT "invoice_line_item_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "engagement"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice" ADD CONSTRAINT "invoice_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice" ADD CONSTRAINT "invoice_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice" ADD CONSTRAINT "invoice_primary_engagement_id_engagement_id_fk" FOREIGN KEY ("primary_engagement_id") REFERENCES "engagement"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_created_by_id_app_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "milestone_plan" ADD CONSTRAINT "milestone_plan_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "engagement"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "milestone" ADD CONSTRAINT "milestone_plan_id_milestone_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "milestone_plan"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "office" ADD CONSTRAINT "office_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment" ADD CONSTRAINT "payment_invoice_id_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reason_code" ADD CONSTRAINT "reason_code_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recurring_billing_plan_service" ADD CONSTRAINT "recurring_billing_plan_service_plan_id_recurring_billing_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "recurring_billing_plan"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recurring_billing_plan_service" ADD CONSTRAINT "recurring_billing_plan_service_service_line_id_service_line_id_fk" FOREIGN KEY ("service_line_id") REFERENCES "service_line"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recurring_billing_plan" ADD CONSTRAINT "recurring_billing_plan_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "engagement"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role" ADD CONSTRAINT "role_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_line_rate" ADD CONSTRAINT "service_line_rate_service_line_id_service_line_id_fk" FOREIGN KEY ("service_line_id") REFERENCES "service_line"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_line_rate" ADD CONSTRAINT "service_line_rate_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_line" ADD CONSTRAINT "service_line_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_engagement_id_engagement_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "engagement"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_work_code_id_work_code_id_fk" FOREIGN KEY ("work_code_id") REFERENCES "work_code"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entry_version" ADD CONSTRAINT "time_entry_version_time_entry_id_time_entry_id_fk" FOREIGN KEY ("time_entry_id") REFERENCES "time_entry"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entry_version" ADD CONSTRAINT "time_entry_version_edited_by_id_app_user_id_fk" FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "timekeeper_rate" ADD CONSTRAINT "timekeeper_rate_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_role" ADD CONSTRAINT "user_role_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "app_user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_webhook_endpoint_id_webhook_endpoint_id_fk" FOREIGN KEY ("webhook_endpoint_id") REFERENCES "webhook_endpoint"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "work_code" ADD CONSTRAINT "work_code_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "work_code" ADD CONSTRAINT "work_code_service_line_id_service_line_id_fk" FOREIGN KEY ("service_line_id") REFERENCES "service_line"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_portal_access" ADD CONSTRAINT "client_portal_access_portal_identity_id_portal_identity_id_fk" FOREIGN KEY ("portal_identity_id") REFERENCES "portal_identity"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_portal_access" ADD CONSTRAINT "client_portal_access_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_portal_access" ADD CONSTRAINT "client_portal_access_invited_by_app_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "app_user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "client_portal_access" ADD CONSTRAINT "client_portal_access_revoked_by_app_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "app_user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_method" ADD CONSTRAINT "payment_method_portal_identity_id_portal_identity_id_fk" FOREIGN KEY ("portal_identity_id") REFERENCES "portal_identity"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_auth_challenge" ADD CONSTRAINT "portal_auth_challenge_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_identity" ADD CONSTRAINT "portal_identity_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_firm_id_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "firm"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_client_id_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "client"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_portal_identity_id_portal_identity_id_fk" FOREIGN KEY ("portal_identity_id") REFERENCES "portal_identity"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_invitation" ADD CONSTRAINT "portal_invitation_invited_by_app_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "app_user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_portal_identity_id_portal_identity_id_fk" FOREIGN KEY ("portal_identity_id") REFERENCES "portal_identity"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_session" ADD CONSTRAINT "portal_session_active_client_id_client_id_fk" FOREIGN KEY ("active_client_id") REFERENCES "client"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
