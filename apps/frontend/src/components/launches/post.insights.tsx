'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import type {
  PostInsights,
  PostInsightMetric,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

const usePostInsights = (postId: string, days: number) => {
  const fetch = useFetch();
  const load = useCallback(async () => {
    const response = await fetch(
      `/analytics/post/${postId}/insights?days=${days}`
    );
    if (!response.ok)
      throw new Error(
        'Could not collect insights. Check the connection and try again.'
      );
    return response.json() as Promise<PostInsights & { collectedAt?: string }>;
  }, [fetch, postId, days]);
  return useSWR(`post-insights:${postId}:${days}`, load, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 60_000,
  });
};

function formatMetric(metric: PostInsightMetric) {
  if (metric.value === null) return 'Unavailable';
  const value =
    metric.unit === 'milliseconds' ? metric.value / 1000 : metric.value;
  const unit =
    metric.unit === 'milliseconds' || metric.unit === 'seconds'
      ? ' s'
      : metric.unit === 'minutes'
      ? ' min'
      : metric.unit === 'percent'
      ? '%'
      : '';
  return (
    value.toLocaleString(undefined, {
      maximumFractionDigits: metric.unit === 'count' ? 0 : 2,
    }) + unit
  );
}

export const PostInsightsPanel = ({
  postId,
  days,
}: {
  postId: string;
  days: number;
}) => {
  const { data, error, isLoading, isValidating, mutate } = usePostInsights(
    postId,
    days
  );
  const points = [...(data?.retention || [])].sort(
    (a, b) => a.elapsedRatio - b.elapsedRatio
  );
  // Rewatches can legitimately exceed 100%; preserve the returned ratio.
  const top = Math.max(1, ...points.map((p) => p.audienceWatchRatio));
  const path = points
    .map(
      (p) =>
        `${40 + p.elapsedRatio * 540},${
          170 - (p.audienceWatchRatio / top) * 140
        }`
    )
    .join(' ');
  return (
    <section
      className="flex flex-col gap-4"
      aria-label="Watch time and retention"
    >
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-lg font-medium">Watch time and retention</h3>
        <button
          type="button"
          className="border border-newTableBorder rounded-lg px-3 py-2 text-sm disabled:opacity-50"
          onClick={() => void mutate()}
          disabled={isValidating}
        >
          {isValidating ? 'Collecting…' : 'Refresh insights'}
        </button>
      </div>
      {isLoading && <p role="status">Collecting platform insights…</p>}
      {error && (
        <p role="alert">
          Could not collect insights. Check the channel connection and try
          again.
        </p>
      )}
      {data?.collectedAt && (
        <p className="text-sm text-newTableText">
          Collected {new Date(data.collectedAt).toLocaleString()}. Instagram
          metrics cover the post’s lifetime; YouTube metrics cover the selected{' '}
          {days} days. Platform reporting can lag.
        </p>
      )}
      {!!data?.metrics.length && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.metrics.map((metric) => (
            <div
              key={metric.key}
              className="bg-newTableHeader border border-newTableBorder rounded-xl p-4"
              title={metric.unavailable || metric.source}
            >
              <div className="text-sm text-newTableText">{metric.label}</div>
              <div className="text-2xl font-semibold mt-2">
                {formatMetric(metric)}
              </div>
              {metric.value === null && (
                <p className="text-xs text-newTableText mt-2">
                  {metric.unavailable || 'No data available'}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {points.length > 0 ? (
        <div className="border border-newTableBorder rounded-xl p-4">
          <p className="font-medium mb-2">Audience watch ratio</p>
          <svg
            viewBox="0 0 610 205"
            className="w-full"
            role="img"
            aria-label="YouTube audience watch ratio across the video"
          >
            <line
              x1="40"
              y1="170"
              x2="580"
              y2="170"
              stroke="currentColor"
              opacity="0.3"
            />
            <line
              x1="40"
              y1="30"
              x2="40"
              y2="170"
              stroke="currentColor"
              opacity="0.3"
            />
            <text x="4" y="35" fill="currentColor" fontSize="11">
              {Math.round(top * 100)}%
            </text>
            <text x="12" y="174" fill="currentColor" fontSize="11">
              0%
            </text>
            <text x="40" y="195" fill="currentColor" fontSize="11">
              Start
            </text>
            <text x="550" y="195" fill="currentColor" fontSize="11">
              End
            </text>
            <polyline
              points={path}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            {points.map((p, i) => (
              <circle
                key={i}
                cx={40 + p.elapsedRatio * 540}
                cy={170 - (p.audienceWatchRatio / top) * 140}
                r="3"
                fill="currentColor"
              >
                <title>
                  {(p.elapsedRatio * 100).toFixed(0)}% through video:{' '}
                  {(p.audienceWatchRatio * 100).toFixed(1)}% watch ratio
                  {p.relativePerformance === undefined
                    ? ''
                    : `; relative performance ${p.relativePerformance.toFixed(
                        2
                      )}`}
                </title>
              </circle>
            ))}
          </svg>
          <p className="text-sm text-newTableText">
            Rewatches can take the ratio above 100%. Relative performance is a
            comparison with videos of similar length, not a viewer percentage.
          </p>
        </div>
      ) : (
        data?.retentionUnavailable && (
          <p className="text-sm text-newTableText">
            {data.retentionUnavailable}
          </p>
        )
      )}
    </section>
  );
};
