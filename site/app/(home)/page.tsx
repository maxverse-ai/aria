import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="flex flex-col justify-center text-center flex-1 px-6">
      <h1 className="text-4xl font-bold mb-4">Aria</h1>
      <p className="text-fd-muted-foreground max-w-xl mx-auto mb-8">
        A local-first control plane for coding agents. Chat is the remote
        control, not the compute plane.
      </p>
      <div className="flex flex-row justify-center gap-3">
        <Link
          href="/docs"
          className="rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground"
        >
          Read the docs
        </Link>
        <a
          href="https://github.com/maxverse-ai/aria"
          className="rounded-lg border px-5 py-2.5 font-medium"
        >
          GitHub
        </a>
      </div>
    </div>
  );
}
