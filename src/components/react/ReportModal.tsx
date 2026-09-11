import { useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';

interface ReportModalProps {
  entityType: 'builder' | 'project' | 'media';
  entityId: string;
}

export function ReportModal({ entityType, entityId }: ReportModalProps) {
  const { authenticated, login } = usePrivy();
  const [isOpen, setIsOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [reason, setReason] = useState<string>('other');
  const [details, setDetails] = useState('');

  if (success) {
    return (
      <div className="text-sm font-medium text-emerald-600 bg-emerald-50 px-3 py-2 rounded-md border border-emerald-100 inline-flex items-center gap-2">
        <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" /></svg>
        Thanks — we've received your report.
      </div>
    );
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => {
          if (!authenticated) {
            login();
          } else {
            setIsOpen(true);
          }
        }}
        className="text-sm text-neutral-400 hover:text-neutral-700 underline decoration-neutral-300 underline-offset-4"
        title="Report this content"
      >
        Report
      </button>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authenticated) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType, entityId, reason, details }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || 'Failed to submit report');
      }

      setSuccess(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden border border-neutral-200">
        <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between">
          <h2 className="font-semibold text-neutral-900">Report Content</h2>
          <button onClick={() => setIsOpen(false)} className="text-neutral-400 hover:text-neutral-600">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" /></svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="text-sm text-red-600 bg-red-50 p-3 rounded-md">{error}</div>
          )}

          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1">
              Why are you reporting this?
            </label>
            <select
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full text-sm border border-neutral-300 rounded-lg p-2.5 focus:ring-2 focus:ring-black focus:border-black outline-none"
            >
              <option value="spam">Spam or misleading</option>
              <option value="impersonation">Impersonation</option>
              <option value="harassment">Harassment or abusive</option>
              <option value="inappropriate_content">Inappropriate content</option>
              <option value="stolen_work">Stolen work</option>
              <option value="unsafe_link">Unsafe links</option>
              <option value="copyright">Copyright violation</option>
              <option value="privacy">Privacy violation</option>
              <option value="other">Other</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1">
              Tell us more <span className="text-neutral-400 font-normal">(optional)</span>
            </label>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={3}
              placeholder="Any additional details..."
              className="w-full text-sm border border-neutral-300 rounded-lg p-2.5 focus:ring-2 focus:ring-black focus:border-black outline-none resize-none"
            />
          </div>

          <div className="pt-2 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="px-4 py-2 text-sm font-medium text-neutral-700 hover:text-black"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 text-sm font-medium text-white bg-black hover:bg-neutral-800 rounded-lg disabled:opacity-50"
            >
              {isSubmitting ? 'Submitting...' : 'Submit report'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
