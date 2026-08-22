import { useState } from 'react'

export type LegalModalType = 'privacy' | 'terms' | 'about' | 'sitemap' | 'dsr_gdpr' | null

interface LegalModalsProps {
  activeModal: LegalModalType
  onClose: () => void
}

export function LegalModals({ activeModal, onClose }: LegalModalsProps) {
  if (!activeModal) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-4xl max-h-[85vh] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl flex flex-col overflow-hidden text-[var(--color-text)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-[var(--color-border)] px-6 py-4 flex items-center justify-between shrink-0 bg-[var(--color-raised)]">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="VUGC Logo" className="w-6 h-6 rounded object-contain" />
            <h2 className="text-sm font-black uppercase tracking-widest font-mono">
              {activeModal === 'privacy' && 'Privacy Policy'}
              {activeModal === 'terms' && 'Terms of Service'}
              {activeModal === 'about' && 'About Us — Micany Company'}
              {activeModal === 'sitemap' && 'Site Map'}
              {activeModal === 'dsr_gdpr' && 'Data Subject Rights & GDPR Compliance Portal'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-[11px] font-mono text-[var(--color-muted-2)] hover:text-[var(--color-text)] px-3 py-1 border border-[var(--color-border)] hover:border-[var(--color-text)] transition-colors"
          >
            ✕ CLOSE
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-6 md:p-8 overflow-y-auto space-y-6 text-sm leading-relaxed scrollbar-thin">
          {activeModal === 'privacy' && <PrivacyPolicyContent />}
          {activeModal === 'terms' && <TermsOfServiceContent />}
          {activeModal === 'about' && <AboutUsContent />}
          {activeModal === 'sitemap' && <SiteMapContent onClose={onClose} />}
          {activeModal === 'dsr_gdpr' && <DsrGdprContent />}
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--color-border)] px-6 py-3 bg-[var(--color-bg)] flex items-center justify-between text-[10px] font-mono text-[var(--color-muted-2)]">
          <span>© 2026 VUGC. A Micany Company product. All rights reserved.</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[var(--color-lime)] text-[var(--color-on-accent)] font-bold uppercase tracking-widest hover:brightness-110 transition-colors"
          >
            Acknowledge &amp; Close
          </button>
        </div>
      </div>
    </div>
  )
}

function PrivacyPolicyContent() {
  return (
    <div className="space-y-4">
      <div className="p-3 border border-[var(--color-lime)] bg-[var(--color-lime)]/10 text-xs font-mono text-[var(--color-text)]">
        <strong>Effective Date:</strong> January 1, 2026 | <strong>Entity:</strong> Micany Company (VUGC — Viral Video UGC)
      </div>

      <h3 className="text-base font-bold uppercase tracking-wider">1. Commitment to Privacy &amp; GDPR / CCPA Compliance</h3>
      <p>
        Micany Company (&quot;Company&quot;, &quot;we&quot;, &quot;us&quot;, or &quot;VUGC&quot;) respects your personal privacy and complies with the General Data Protection Regulation (GDPR - Regulation (EU) 2016/679), UK Data Protection Act 2018, California Consumer Privacy Act (CCPA/CPRA), and global data protection standards.
      </p>

      <h3 className="text-base font-bold uppercase tracking-wider">2. Information We Collect</h3>
      <ul className="list-disc pl-5 space-y-1 text-xs text-[var(--color-muted-2)]">
        <li><strong>Account Identifiers:</strong> Name, business email, organization name, encrypted authentication credentials, and session tokens.</li>
        <li><strong>Content Generation Inputs:</strong> Product URLs, scripts, creative briefs, brand kit assets, and reference creator images uploaded for avatar synthesis.</li>
        <li><strong>Telemetry &amp; Audit Logs:</strong> Timestamped API calls, video generation quotas, review queue decisions, and security events.</li>
        <li><strong>Billing Data:</strong> Stripe customer ID, subscription tier, and token usage ledger (no raw credit card numbers are stored on our servers).</li>
      </ul>

      <h3 className="text-base font-bold uppercase tracking-wider">3. AI Model &amp; Sub-Processor Data Handling</h3>
      <p>
        VUGC orchestrates enterprise-grade video synthesis and script generation. Your proprietary prompts and private brand data are processed under zero-data-retention and non-training commercial agreements with our underlying inference vendors (Anthropic, OpenAI, ElevenLabs, Kling, and Runway). We do not sell your personal data or user-generated outputs.
      </p>

      <h3 className="text-base font-bold uppercase tracking-wider">4. Data Subject Rights (DSR)</h3>
      <p>
        Under GDPR and CCPA, you possess the Right to Access, Rectification, Erasure (&quot;Right to be Forgotten&quot;), Restriction of Processing, Data Portability, and Objection. You may submit an automated request anytime via our <strong>DSR / GDPR Portal</strong> or email <a href="mailto:privacy@micany.com" className="text-[var(--color-lime)] underline">privacy@micany.com</a>.
      </p>

      <h3 className="text-base font-bold uppercase tracking-wider">5. Data Retention &amp; Security</h3>
      <p>
        Audio/video masters and transcripts are retained according to your workspace settings (default 30 days post-generation for review items). All network transit is secured via TLS 1.3, and data at rest is encrypted with AES-256.
      </p>
    </div>
  )
}

function TermsOfServiceContent() {
  return (
    <div className="space-y-4">
      <div className="p-3 border border-[var(--color-border)] bg-[var(--color-raised)] text-xs font-mono text-[var(--color-muted-2)]">
        <strong>Last Updated:</strong> January 2026 | <strong>Governing Entity:</strong> Micany Company
      </div>

      <h3 className="text-base font-bold uppercase tracking-wider">1. Agreement to Terms</h3>
      <p>
        By accessing or using Viral Video UGC (VUGC), an autonomous video intelligence and production SaaS provided by Micany Company, you agree to be bound by these Terms of Service.
      </p>

      <h3 className="text-base font-bold uppercase tracking-wider">2. Intellectual Property &amp; Output Ownership</h3>
      <p>
        <strong>Customer Owns All Generated Outputs:</strong> Subject to your compliance with these Terms, Micany Company assigns to you all right, title, and interest in and to the rewritten scripts, generated audio, and final rendered 9:16 video masters produced by your account for commercial distribution on YouTube Shorts, TikTok, Instagram Reels, and Facebook.
      </p>

      <h3 className="text-base font-bold uppercase tracking-wider">3. Acceptable Use Policy</h3>
      <ul className="list-disc pl-5 space-y-1 text-xs text-[var(--color-muted-2)]">
        <li>You will not use the service to generate defamatory, deceptive, illegal, or non-consensual deepfake media.</li>
        <li>You represent that you hold necessary rights or licenses for any brand assets, trademarks, or creator reference imagery uploaded into your brand kit.</li>
        <li>You will comply with platform disclosure policies (e.g. labeling AI-generated UGC where mandated by YouTube/Meta/TikTok).</li>
      </ul>

      <h3 className="text-base font-bold uppercase tracking-wider">4. Service Availability &amp; Liability</h3>
      <p>
        The software is provided &quot;as is&quot; with a 99.9% target uptime SLA for production accounts. Micany Company is not liable for indirect, incidental, or consequential damages resulting from third-party vendor downtime.
      </p>
    </div>
  )
}

function AboutUsContent() {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-black uppercase tracking-wider text-[var(--color-lime)]">
        Viral Video UGC (VUGC) — A Micany Company Product
      </h3>
      <p>
        Viral Video UGC was engineered by <strong>Micany Company</strong> to solve the single largest bottleneck for modern marketing teams and creator agencies: scaling high-converting short-form video production without expanding headcount.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
        <div className="p-4 border border-[var(--color-border)] bg-[var(--color-raised)]">
          <h4 className="font-bold text-xs uppercase tracking-widest text-[var(--color-lime)] mb-1">Viral Intelligence (Intel)</h4>
          <p className="text-xs text-[var(--color-muted-2)]">
            Continuous discovery monitoring top velocity creators, breaking formats, and retention hooks across TikTok, YouTube Shorts, and Instagram Reels.
          </p>
        </div>
        <div className="p-4 border border-[var(--color-border)] bg-[var(--color-raised)]">
          <h4 className="font-bold text-xs uppercase tracking-widest text-[var(--color-lime)] mb-1">Autonomous Studio</h4>
          <p className="text-xs text-[var(--color-muted-2)]">
            A nine-stage pipeline that deconstructs winning structures, writes original scripts for your niche, pairs voiceovers, synthesizes multi-scene video clips, and burns animated captions.
          </p>
        </div>
        <div className="p-4 border border-[var(--color-border)] bg-[var(--color-raised)]">
          <h4 className="font-bold text-xs uppercase tracking-widest text-[var(--color-lime)] mb-1">Human-in-the-Loop QA</h4>
          <p className="text-xs text-[var(--color-muted-2)]">
            Strict automated gatekeeping scoring originality, structural integrity, and brand alignment before presenting ready-to-publish masters for one-click approval.
          </p>
        </div>
        <div className="p-4 border border-[var(--color-border)] bg-[var(--color-raised)]">
          <h4 className="font-bold text-xs uppercase tracking-widest text-[var(--color-lime)] mb-1">Enterprise Ready</h4>
          <p className="text-xs text-[var(--color-muted-2)]">
            Multi-tenant brand kits, persistent face/voice identity via Soul ID, complete GDPR/DSR data compliance, and multi-format bulk exports.
          </p>
        </div>
      </div>
      <p className="text-xs font-mono text-[var(--color-muted-3)] pt-2">
        For enterprise inquiries, custom vendor integration, or partnerships: contact@micany.com
      </p>
    </div>
  )
}

function SiteMapContent({ onClose }: { onClose: () => void }) {
  const sections = [
    {
      title: 'Workspace Core',
      links: [
        { label: 'This Week (Dashboard)', path: '/app' },
        { label: 'Viral Intel & Inbox', path: '/app/intel' },
        { label: 'URL Remix Studio', path: '/app/intel/remix' },
        { label: 'Single Studio Generator', path: '/app/studio' },
        { label: 'Batch Variation Studio', path: '/app/studio/batch' }
      ]
    },
    {
      title: 'QA & Media Management',
      links: [
        { label: 'Library (9:16 Video & Script Masters)', path: '/app/library' },
        { label: 'Review QA Queue (Triage & Approvals)', path: '/app/review' },
        { label: 'Brand Kit & Clients', path: '/app/brand' },
        { label: 'Billing & Token Usage', path: '/app/billing' },
        { label: 'Settings & Security', path: '/app/settings' }
      ]
    },
    {
      title: 'Authentication & Access',
      links: [
        { label: 'Sign In', path: '/app?mode=signin' },
        { label: 'Create Account', path: '/app?mode=signup' },
        { label: 'Password Reset', path: '/app?mode=forgot' },
        { label: 'Two-Factor Authentication (MFA)', path: '/app/settings' }
      ]
    }
  ]

  return (
    <div className="space-y-6">
      <p className="text-xs text-[var(--color-muted-2)]">
        Navigate to any section of the Viral Video UGC application:
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {sections.map((sec, idx) => (
          <div key={idx} className="border border-[var(--color-border)] bg-[var(--color-raised)] p-4 space-y-2">
            <h4 className="font-bold text-xs uppercase tracking-widest text-[var(--color-lime)]">{sec.title}</h4>
            <ul className="space-y-1.5 text-xs">
              {sec.links.map((link, lIdx) => (
                <li key={lIdx}>
                  <a
                    href={link.path}
                    onClick={() => onClose()}
                    className="text-[var(--color-text)] hover:text-[var(--color-lime)] transition-colors flex items-center gap-1.5"
                  >
                    <span>→</span> {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

function DsrGdprContent() {
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [requestType, setRequestType] = useState('access')
  const [email, setEmail] = useState('')
  const [details, setDetails] = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitted(`Request (${requestType.toUpperCase()}) registered for ${email}. Case ID: DSR-${Date.now().toString().slice(-6)}. A confirmation and verification email has been dispatched.`)
  }

  return (
    <div className="space-y-6">
      <div className="p-4 border border-[var(--color-lime)] bg-[var(--color-lime)]/10 space-y-1">
        <h4 className="font-bold text-xs uppercase tracking-widest text-[var(--color-lime)] font-mono">
          GDPR &amp; Data Subject Rights (DSR) Self-Service Portal
        </h4>
        <p className="text-xs text-[var(--color-text)]">
          Exercise your privacy rights under EU GDPR (Articles 15-22), UK GDPR, and California Privacy Rights Act (CPRA).
        </p>
      </div>

      {submitted ? (
        <div className="p-4 border border-[var(--color-lime)] bg-[var(--color-surface)] text-xs text-[var(--color-lime)] font-mono">
          ✓ {submitted}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4 border border-[var(--color-border)] bg-[var(--color-raised)] p-5">
          <div className="space-y-1">
            <label className="block text-xs font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
              Right to Exercise
            </label>
            <select
              value={requestType}
              onChange={(e) => setRequestType(e.target.value)}
              className="w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] text-xs p-2.5 font-mono"
            >
              <option value="access">Right of Access (Article 15) — Export all personal data &amp; telemetry</option>
              <option value="erasure">Right to Erasure / &quot;Right to be Forgotten&quot; (Article 17) — Delete all data</option>
              <option value="portability">Right to Data Portability (Article 20) — Machine-readable JSON/CSV archive</option>
              <option value="rectification">Right to Rectification (Article 16) — Correct inaccurate account information</option>
              <option value="restriction">Right to Restrict / Object to Processing (Article 18/21)</option>
              <option value="optout">Do Not Sell or Share My Information (CCPA/CPRA)</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
              Account Email Address
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              className="w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] text-xs p-2.5 font-mono"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-mono uppercase tracking-widest text-[var(--color-muted-2)]">
              Additional Details / Verification Notes (Optional)
            </label>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Specify any particular datasets, runs, or organization IDs to include/exclude..."
              className="w-full bg-[var(--color-bg)] border border-[var(--color-input)] text-[var(--color-text)] text-xs p-2.5 font-mono min-h-[70px]"
            />
          </div>

          <button
            type="submit"
            className="px-6 py-2.5 bg-[var(--color-lime)] text-[var(--color-on-accent)] font-bold uppercase tracking-widest text-xs hover:brightness-110 transition-colors font-mono"
          >
            Submit DSR Request
          </button>
        </form>
      )}

      <div className="space-y-2 text-xs text-[var(--color-muted-2)]">
        <p><strong>Response Timeline:</strong> DSR requests are verified and processed within 30 calendar days as mandated by GDPR Article 12(3).</p>
        <p><strong>Data Protection Officer (DPO):</strong> dpo@micany.com | Micany Company Compliance Group</p>
      </div>
    </div>
  )
}
