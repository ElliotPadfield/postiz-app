'use client';

import { useCallback, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

const usePublishingStatus = (postId: string) => {
  const fetch = useFetch();
  const load = useCallback(async () => {
    const response = await fetch(`/posts/${postId}/publishing`);
    if (!response.ok) throw new Error('Could not load publishing status');
    return response.json() as Promise<{ state: string } | null>;
  }, [fetch, postId]);
  return useSWR(`publishing-status:${postId}`, load, {
    revalidateOnFocus: false,
  });
};

export const PublishingReview = ({ postId }: { postId: string }) => {
  const fetch = useFetch();
  const { data } = usePublishingStatus(postId);
  const [releaseId, setReleaseId] = useState('');
  const [releaseURL, setReleaseURL] = useState('');
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  if (data?.state !== 'REVIEW') return null;
  return (
    <section className="border border-newTableBorder rounded-xl p-4 flex flex-col gap-3">
      <h3 className="text-lg font-medium">Check the publishing outcome</h3>
      <p>
        The platform may have accepted this post. Check the account before
        posting it again. If it is live, record its platform ID and link below.
        This records the result without sending any content or remaining
        comments.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setError('');
          try {
            const response = await fetch(
              `/posts/${postId}/publishing/confirm`,
              {
                method: 'PUT',
                body: JSON.stringify({
                  releaseId: releaseId.trim(),
                  releaseURL: releaseURL.trim(),
                }),
              }
            );
            if (!response.ok)
              throw new Error(
                'Could not record this result. Check the details and refresh the page.'
              );
            window.location.reload();
          } catch {
            setError(
              'Could not record this result. Check the details and try again.'
            );
          } finally {
            setSaving(false);
          }
        }}
      >
        <label className="flex flex-col gap-1">
          Platform post ID
          <input
            className="bg-newTableHeader border border-newTableBorder rounded-lg p-2"
            value={releaseId}
            onChange={(event) => setReleaseId(event.target.value)}
            required
            maxLength={500}
          />
        </label>
        <label className="flex flex-col gap-1">
          Published link
          <input
            className="bg-newTableHeader border border-newTableBorder rounded-lg p-2"
            type="url"
            pattern="https://.*"
            value={releaseURL}
            onChange={(event) => setReleaseURL(event.target.value)}
            required
            maxLength={2000}
          />
        </label>
        <label className="flex gap-2 items-center">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            required
          />
          I checked the account and this post is live.
        </label>
        <button
          className="border border-newTableBorder rounded-lg px-3 py-2 self-start disabled:opacity-50"
          type="submit"
          disabled={saving || !checked}
        >
          {saving ? 'Recording…' : 'Record published result'}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
};
