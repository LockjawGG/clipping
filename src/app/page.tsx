import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <h1 className="text-4xl font-semibold tracking-tight">Clipper</h1>
      <p className="text-lg text-muted">
        Upload a long video or paste a link. Clipper transcribes it, finds the
        moments worth sharing, and renders vertical clips with burned-in captions
        — trim the boundaries and preview the captions right in the browser.
      </p>
      <Link href="/dashboard" className="btn btn-primary w-fit px-4 py-2">
        Go to the dashboard
      </Link>
    </main>
  );
}
