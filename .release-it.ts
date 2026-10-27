import type { Config } from 'release-it';

// Pushing the v* tag triggers Forgejo CI (.forgejo/workflows/ci.yml), which runs the tests and
// then builds+pushes docker.zacaj.com/web-syncr:<version> -- no local image build here anymore.
export default {
  git: {
    commitMessage: `chore: release v\${version}`,
    tagName: `v\${version}`,
    tagAnnotation: `Release v\${version}`,
    push: true,
    requireBranch: `main`,
    requireUpstream: true,
  },
  npm: {
    publish: false,
  },
} satisfies Config;
