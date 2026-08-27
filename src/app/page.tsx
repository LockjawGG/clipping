export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <h1 className="text-4xl font-semibold tracking-tight">Clipper</h1>
      <p className="text-lg text-neutral-600 dark:text-neutral-400">
        Upload a long video, get back short vertical clips with burned-in
        captions. The core algorithms &mdash; caption layout, sentence-boundary
        snapping, and ffmpeg argv construction &mdash; are in{" "}
        <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-sm dark:bg-neutral-800">
          src/lib
        </code>
        .
      </p>
      <p className="text-sm text-neutral-500">
        This scaffold wires up Next.js, Tailwind, and the Prisma client. The
        upload flow, transcript editor, and render pipeline land in later PRs.
      </p>
    </main>
  );
}
