/**
 * File type table for the file icons (docs/spec/file-icons.md).
 *
 * One row per icon. `look` says how the icon is drawn:
 *   "family:Glyph"  a drawn Phosphor file glyph (FileTs, FilePdf, ...), coloured by family
 *   "family=Ab"     the plain file shape with a monogram of one or two characters
 * `ext` lists extensions without the dot. A dotted entry ("d.ts", "tar.gz") is a compound extension.
 * `names` lists exact file names, lower case. `rx` lists patterns for names with a variable part.
 * Look-ups are ordered: exact name, then pattern, then the longest matching extension.
 * No glyph, label or colour is copied from another icon set. The row set follows the public list of
 * file types such sets cover, not their artwork.
 */

export type Family =
    | "neutral"
    | "blue"
    | "cyan"
    | "teal"
    | "green"
    | "lime"
    | "yellow"
    | "orange"
    | "red"
    | "pink"
    | "purple"
    | "indigo";

export interface TypeRow {
    id: string;
    look: string;
    ext?: string;
    names?: string;
    rx?: RegExp[];
}

/** Phase 1 and 2 rows. Phase 3 rows (long tail) are listed in the spec and are not added yet. */
export const TYPES: readonly TypeRow[] = [
    // Web and scripting languages
    { id: "javascript", look: "yellow:Js", ext: "js mjs cjs es6 js.map" },
    { id: "jsx", look: "yellow:Jsx", ext: "jsx" },
    { id: "typescript", look: "blue:Ts", ext: "ts mts cts" },
    { id: "tsx", look: "blue:Tsx", ext: "tsx" },
    { id: "typescript-def", look: "blue=DT", ext: "d.ts d.mts d.cts" },
    { id: "test-js", look: "green=T", ext: "test.js test.jsx test.mjs spec.js spec.jsx test.cjs" },
    { id: "test-ts", look: "green=T", ext: "test.ts test.tsx spec.ts spec.tsx test.mts e2e.ts bench.ts" },
    { id: "vue", look: "green:Vue", ext: "vue" },
    { id: "svelte", look: "orange=Sv", ext: "svelte" },
    { id: "astro", look: "purple=As", ext: "astro" },
    { id: "html", look: "orange:Html", ext: "html htm xhtml shtml" },
    { id: "css", look: "blue:Css", ext: "css pcss postcss" },
    { id: "sass", look: "pink=Sa", ext: "scss sass" },
    { id: "less", look: "indigo=Ls", ext: "less" },
    { id: "stylus", look: "green=St", ext: "styl stylus" },
    { id: "coffee", look: "orange=Cf", ext: "coffee litcoffee" },
    { id: "handlebars", look: "orange=Hb", ext: "hbs handlebars mustache" },
    { id: "pug", look: "orange=Pg", ext: "pug jade" },
    { id: "template", look: "teal=Tp", ext: "ejs erb jinja jinja2 j2 njk twig liquid tpl tmpl" },
    { id: "python", look: "yellow:Py", ext: "py pyw pyi pyx pxd" },
    { id: "notebook", look: "orange=Nb", ext: "ipynb" },
    { id: "ruby", look: "red=Rb", ext: "rb rake gemspec ru erb.rb" },
    { id: "php", look: "indigo=Ph", ext: "php phtml php3 php4 php5 phps" },
    { id: "perl", look: "blue=Pl", ext: "pl pm pod t" },
    { id: "lua", look: "indigo=Lu", ext: "lua luau" },
    { id: "r", look: "blue=R", ext: "r rmd rds rproj" },
    { id: "julia", look: "purple=Jl", ext: "jl" },
    { id: "dart", look: "cyan=Da", ext: "dart" },
    { id: "elixir", look: "purple=Ex", ext: "ex exs eex heex leex" },
    { id: "erlang", look: "red=Er", ext: "erl hrl escript" },
    { id: "clojure", look: "green=Cj", ext: "clj cljs cljc edn" },
    { id: "haskell", look: "purple=Hs", ext: "hs lhs cabal" },
    { id: "ocaml", look: "orange=ML", ext: "ml mli mll mly" },
    { id: "fsharp", look: "blue=F#", ext: "fs fsi fsx fsscript" },
    { id: "elm", look: "cyan=Em", ext: "elm" },
    { id: "lisp", look: "indigo=Li", ext: "lisp lsp cl el scm ss rkt" },
    { id: "nim", look: "yellow=Nm", ext: "nim nims nimble" },
    { id: "crystal", look: "neutral=Cr", ext: "cr" },
    { id: "groovy", look: "cyan=Gv", ext: "groovy gvy gradle.kts" },
    { id: "gdscript", look: "blue=Gd", ext: "gd gdshader tscn tres" },

    // Systems languages
    { id: "c", look: "blue:C", ext: "c" },
    { id: "c-header", look: "indigo=H", ext: "h" },
    { id: "cpp", look: "blue:Cpp", ext: "cpp cc cxx c++ ino" },
    { id: "cpp-header", look: "indigo=Hp", ext: "hpp hh hxx h++ tpp ipp" },
    { id: "csharp", look: "purple:CSharp", ext: "cs csx" },
    { id: "rust", look: "orange:Rs", ext: "rs" },
    { id: "go", look: "cyan=Go", ext: "go" },
    { id: "zig", look: "orange=Zg", ext: "zig zon" },
    { id: "swift", look: "orange=Sw", ext: "swift" },
    { id: "objc", look: "blue=Oc", ext: "m mm" },
    { id: "java", look: "red=Jv", ext: "java jsp jspx" },
    { id: "kotlin", look: "purple=Kt", ext: "kt kts" },
    { id: "scala", look: "red=Sc", ext: "scala sc sbt" },
    { id: "vb", look: "blue=VB", ext: "vb vbs vba" },
    { id: "d", look: "red=D", ext: "d di" },
    { id: "fortran", look: "purple=Fo", ext: "f f77 f90 f95 f03 for" },
    { id: "pascal", look: "orange=Pa", ext: "pas pp dpr lpr" },
    { id: "ada", look: "green=Ad", ext: "adb ads ada" },
    { id: "cobol", look: "blue=Cb", ext: "cob cbl cpy" },
    { id: "assembly", look: "red=As", ext: "asm s nasm" },
    { id: "solidity", look: "neutral=So", ext: "sol" },
    { id: "verilog", look: "green=Vl", ext: "v sv svh vhdl" },
    { id: "wasm", look: "purple=Wa", ext: "wasm wat wast" },
    { id: "cuda", look: "green=Cu", ext: "cu cuh" },
    { id: "glsl", look: "blue=Gl", ext: "glsl vert frag wgsl hlsl shader" },

    // Shell and build
    { id: "shell", look: "green=Sh", ext: "sh bash zsh fish ksh csh tcsh command" },
    { id: "powershell", look: "blue=Ps", ext: "ps1 psm1 psd1" },
    { id: "batch", look: "neutral=Bt", ext: "bat cmd" },
    { id: "awk", look: "neutral=Ak", ext: "awk sed" },
    { id: "makefile", look: "orange=Mk", ext: "mk mak make", names: "makefile gnumakefile" },
    { id: "cmake", look: "green=Cm", ext: "cmake", names: "cmakelists.txt cmakecache.txt" },
    { id: "justfile", look: "orange=Jf", names: "justfile .justfile" },
    { id: "taskfile", look: "green=Tk", names: "taskfile.yml taskfile.yaml" },
    { id: "meson", look: "purple=Ms", names: "meson.build meson_options.txt" },
    { id: "bazel", look: "green=Bz", ext: "bzl bazel", names: "build workspace module.bazel .bazelrc" },
    { id: "gradle", look: "cyan=Gr", ext: "gradle", names: "gradlew gradlew.bat gradle.properties" },
    { id: "maven", look: "red=Mv", names: "pom.xml" },
    { id: "nix", look: "blue=Nx", ext: "nix" },
    {
        id: "docker",
        look: "blue=Dk",
        names: "dockerfile containerfile .dockerignore",
        rx: [/^(docker|container)file[.-]/, /\.dockerfile$/],
    },
    { id: "compose", look: "blue=Dc", rx: [/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/] },
    { id: "terraform", look: "purple=Tf", ext: "tf tfvars tfstate hcl", names: ".terraform.lock.hcl" },
    { id: "vagrant", look: "blue=Vg", names: "vagrantfile" },
    { id: "procfile", look: "purple=Pf", names: "procfile" },
    { id: "kubernetes", look: "blue=K8", rx: [/^(k8s|kube)[-.].*\.ya?ml$/] },
    { id: "systemd", look: "neutral=Sd", ext: "service timer socket mount automount target slice container" },

    // Data and markup
    { id: "json", look: "yellow=JS", ext: "json jsonl ndjson geojson webmanifest har jsonc json5 map" },
    { id: "yaml", look: "red=Ym", ext: "yaml yml" },
    { id: "toml", look: "orange=To", ext: "toml" },
    {
        id: "xml",
        look: "orange=<>",
        ext: "xml xsd xsl xslt dtd plist rss atom wsdl xaml csproj fsproj vbproj sln props targets",
    },
    { id: "ini", look: "neutral:Ini", ext: "ini cfg conf config properties desktop" },
    { id: "env", look: "yellow=En", ext: "env", names: ".envrc", rx: [/^\.env(\.|$)/, /\.env$/] },
    { id: "csv", look: "green:Csv", ext: "csv tsv tab psv" },
    { id: "graphql", look: "pink=Gq", ext: "graphql gql graphqls" },
    { id: "proto", look: "teal=Pb", ext: "proto" },
    { id: "prisma", look: "indigo=Pr", ext: "prisma" },
    { id: "sql", look: "cyan:Sql", ext: "sql psql mysql pgsql ddl" },
    { id: "database", look: "cyan=Db", ext: "sqlite sqlite3 db db3 mdb accdb realm parquet avro orc feather arrow" },
    { id: "log", look: "neutral=Lg", ext: "log logs" },
    { id: "diff", look: "green=Df", ext: "diff patch rej" },
    { id: "regex", look: "neutral=Rx", ext: "regex re" },

    // Documents
    { id: "markdown", look: "blue:Md", ext: "md markdown mdown mkd mkdn" },
    { id: "mdx", look: "yellow=Mx", ext: "mdx" },
    { id: "text", look: "neutral:Txt", ext: "txt text asc" },
    { id: "rst", look: "neutral=Rt", ext: "rst rest" },
    { id: "asciidoc", look: "blue=Ad", ext: "adoc asciidoc" },
    { id: "org", look: "green=Or", ext: "org" },
    { id: "tex", look: "teal=Tx", ext: "tex sty cls bib bbl ltx" },
    { id: "pdf", look: "red:Pdf", ext: "pdf" },
    { id: "word", look: "blue:Doc", ext: "doc docx dot dotx odt rtf pages" },
    { id: "sheet", look: "green:Xls", ext: "xls xlsx xlsm ods numbers" },
    { id: "slides", look: "orange:Ppt", ext: "ppt pptx pps ppsx odp" },
    { id: "ebook", look: "orange=Eb", ext: "epub mobi azw azw3 fb2 djvu" },
    { id: "eml", look: "blue=@", ext: "eml msg mbox" },
    { id: "ics", look: "red=Ca", ext: "ics ical vcf" },

    // Images, audio, video, fonts, 3D, design
    { id: "png", look: "purple:Png", ext: "png apng" },
    { id: "jpeg", look: "purple:Jpg", ext: "jpg jpeg jfif jpe" },
    { id: "svg", look: "orange:Svg", ext: "svg svgz" },
    {
        id: "image",
        look: "purple:Image",
        ext: "gif webp avif bmp tif tiff heic heif jxl dds tga exr hdr pbm pgm ppm raw cr2 nef arw dng",
    },
    { id: "icon", look: "yellow=Ic", ext: "ico icns cur" },
    { id: "photoshop", look: "blue=Ps", ext: "psd psb" },
    { id: "illustrator", look: "orange=Ai", ext: "ai eps" },
    { id: "design", look: "pink=Dg", ext: "sketch fig xd afdesign afphoto kra xcf" },
    { id: "audio", look: "pink:Audio", ext: "mp3 wav ogg oga opus flac m4a aac weba wma aiff aif amr mka" },
    { id: "midi", look: "pink=Mi", ext: "mid midi" },
    { id: "video", look: "pink:Video", ext: "mp4 m4v webm mov ogv mkv avi wmv flv mpg mpeg 3gp" },
    { id: "subtitle", look: "neutral=Sb", ext: "srt vtt ass ssa sub" },
    { id: "font", look: "neutral=Aa", ext: "ttf otf woff woff2 eot fon pfb" },
    { id: "model3d", look: "teal=3D", ext: "obj fbx glb gltf stl dae 3ds ply usdz blend" },

    // Archives, binaries, disks
    { id: "archive-tar", look: "yellow:Archive", ext: "tar tar.gz tar.bz2 tar.xz tar.zst tgz tbz2 txz" },
    { id: "zip", look: "yellow:Zip", ext: "zip jar war ear apk aab ipa nupkg whl egg vsix crx xpi" },
    { id: "archive", look: "yellow:Archive", ext: "gz bz2 xz zst 7z rar lz lzma lz4 cab z br" },
    { id: "disk-image", look: "neutral=Is", ext: "iso dmg img vhd vmdk qcow2" },
    { id: "package", look: "orange=Pk", ext: "deb rpm pkg msi appimage snap flatpak" },
    { id: "executable", look: "neutral=Ex", ext: "exe com app" },
    { id: "library", look: "neutral=Lb", ext: "dll so dylib lib a o obj.o ko" },
    { id: "binary", look: "neutral=Bn", ext: "bin dat dump class pyc pyo elc beam" },

    // Keys, certificates, locks
    {
        id: "key",
        look: "red:Lock",
        ext: "pem key pub p12 pfx jks keystore crt cer der csr gpg pgp sig",
        names: "id_rsa id_ed25519 id_ecdsa id_dsa known_hosts authorized_keys",
    },
    {
        id: "lock",
        look: "neutral:Lock",
        ext: "lock lockb",
        names: "package-lock.json yarn.lock pnpm-lock.yaml bun.lock bun.lockb cargo.lock composer.lock gemfile.lock poetry.lock pipfile.lock uv.lock go.sum flake.lock deno.lock",
    },

    // Project and tool files (exact names)
    { id: "npm", look: "red=Np", names: "package.json .npmrc .npmignore .nvmrc .node-version npm-shrinkwrap.json" },
    { id: "yarn", look: "blue=Yn", names: ".yarnrc .yarnrc.yml .yarnignore" },
    { id: "pnpm", look: "yellow=Pn", names: "pnpm-workspace.yaml .pnpmfile.cjs" },
    { id: "bun", look: "neutral=Bn", names: "bunfig.toml" },
    { id: "deno", look: "neutral=Dn", names: "deno.json deno.jsonc" },
    {
        id: "tsconfig",
        look: "blue=Tc",
        names: "tsconfig.json jsconfig.json",
        rx: [/^tsconfig[.\w-]*\.json$/, /^jsconfig[.\w-]*\.json$/],
    },
    {
        id: "cargo",
        look: "orange=Cg",
        names: "cargo.toml rust-toolchain rust-toolchain.toml rustfmt.toml .rustfmt.toml clippy.toml",
    },
    { id: "go-mod", look: "cyan=Gm", names: "go.mod go.work" },
    {
        id: "python-project",
        look: "yellow=Pp",
        names: "pyproject.toml requirements.txt pipfile setup.py setup.cfg tox.ini manifest.in .python-version conftest.py pytest.ini poetry.toml uv.toml",
        rx: [/^requirements[-.\w]*\.txt$/],
    },
    { id: "gemfile", look: "red=Gf", names: "gemfile rakefile .ruby-version .gemrc" },
    { id: "composer", look: "indigo=Cp", names: "composer.json" },
    {
        id: "git",
        look: "orange=Gi",
        names: ".gitignore .gitattributes .gitmodules .gitkeep .gitconfig .git-blame-ignore-revs .mailmap",
    },
    { id: "editorconfig", look: "neutral=Ec", names: ".editorconfig" },
    {
        id: "prettier",
        look: "pink=Pt",
        names: ".prettierignore",
        rx: [/^\.?prettier(rc|\.config)?(\.[\w]+)?$/, /^\.prettierrc\.[\w]+$/],
    },
    {
        id: "eslint",
        look: "indigo=Es",
        names: ".eslintignore",
        rx: [/^\.eslintrc(\.[\w]+)?$/, /^eslint\.config\.[\w]+$/],
    },
    { id: "stylelint", look: "neutral=Sl", rx: [/^\.?stylelint(rc|\.config)(\.[\w]+)?$/], names: ".stylelintignore" },
    { id: "biome", look: "blue=Bi", names: "biome.json biome.jsonc" },
    { id: "babel", look: "yellow=Bb", rx: [/^\.?babel(rc|\.config)(\.[\w]+)?$/] },
    { id: "webpack", look: "cyan=Wp", rx: [/^webpack[.\w-]*\.[cm]?[jt]s$/] },
    { id: "vite", look: "purple=Vt", rx: [/^vite(st)?\.config\.[\w]+$/, /^vite\.[\w.-]*config\.[\w]+$/] },
    { id: "rollup", look: "red=Ro", rx: [/^rollup\.config\.[\w]+$/] },
    { id: "esbuild", look: "yellow=Eb", rx: [/^esbuild[.\w-]*\.[cm]?[jt]s$/] },
    { id: "turbo", look: "pink=Tu", names: "turbo.json nx.json lerna.json rush.json" },
    { id: "tailwind", look: "cyan=Tw", rx: [/^tailwind\.config\.[\w]+$/] },
    { id: "postcss", look: "red=Pc", rx: [/^\.?postcss(rc|\.config)(\.[\w]+)?$/] },
    { id: "nextjs", look: "neutral=Nj", rx: [/^next(-env\.d|\.config)\.[\w]+$/] },
    { id: "nuxt", look: "green=Nu", rx: [/^nuxt\.config\.[\w]+$/] },
    { id: "svelte-config", look: "orange=Sv", rx: [/^svelte\.config\.[\w]+$/] },
    { id: "astro-config", look: "purple=As", rx: [/^astro\.config\.[\w]+$/] },
    { id: "jest", look: "red=Jt", rx: [/^jest\.[\w.-]*config\.[\w]+$/], names: "jest.setup.ts jest.setup.js" },
    { id: "playwright", look: "green=Pw", rx: [/^playwright[.\w-]*config\.[\w]+$/] },
    { id: "cypress", look: "teal=Cy", rx: [/^cypress[.\w-]*config\.[\w]+$/], names: "cypress.json" },
    { id: "storybook", look: "pink=Sb", rx: [/^\.?storybook\.config\.[\w]+$/] },
    {
        id: "husky",
        look: "neutral=Hu",
        names: ".lintstagedrc .huskyrc .commitlintrc commitlint.config.js lint-staged.config.js",
    },
    { id: "changeset", look: "blue=Cs", names: "renovate.json .renovaterc dependabot.yml dependabot.yaml" },
    { id: "codeowners", look: "neutral=Co", names: "codeowners" },
    {
        id: "ci",
        look: "green=CI",
        names: ".travis.yml .gitlab-ci.yml jenkinsfile azure-pipelines.yml .drone.yml appveyor.yml bitbucket-pipelines.yml cloudbuild.yaml buildkite.yml .woodpecker.yml",
    },
    {
        id: "deploy",
        look: "cyan=Dp",
        names: "netlify.toml vercel.json wrangler.toml wrangler.jsonc fly.toml firebase.json serverless.yml app.yaml railway.json render.yaml now.json amplify.yml",
    },
    { id: "server-config", look: "green=Ng", names: "nginx.conf .htaccess httpd.conf caddyfile haproxy.cfg" },
    { id: "robots", look: "neutral=Rb", names: "robots.txt humans.txt sitemap.xml ads.txt security.txt" },
    { id: "manifest", look: "yellow=Mf", names: "manifest.json manifest.webmanifest" },
    { id: "mise", look: "orange=Mi", names: "mise.toml .mise.toml .tool-versions" },
    { id: "devcontainer", look: "blue=Dv", names: "devcontainer.json .devcontainer.json" },
    { id: "vscode", look: "blue=VS", ext: "code-workspace" },

    // Project documents (exact names, with or without extension)
    { id: "readme", look: "blue=Rd", rx: [/^readme(\.[\w-]+)?$/] },
    { id: "license", look: "yellow=Li", rx: [/^(licen[sc]e|copying|unlicense|notice)(\.[\w-]+)?$/, /^licen[sc]e[-.]/] },
    { id: "changelog", look: "orange=Cl", rx: [/^(changelog|changes|history|news|releases)(\.[\w-]+)?$/] },
    {
        id: "contributing",
        look: "green=Ct",
        rx: [
            /^(contributing|code_of_conduct|code-of-conduct|authors|contributors|maintainers|security|support|governance)(\.[\w-]+)?$/,
        ],
    },
    { id: "todo", look: "yellow=Td", rx: [/^(todo|roadmap|plan)(\.[\w-]+)?$/] },
    {
        id: "agents",
        look: "purple=Ag",
        names: "agents.md claude.md gemini.md copilot-instructions.md .cursorrules .clinerules",
    },
    { id: "makefile-in", look: "orange=Mk", names: "configure.ac configure.in" },
];

/** Look of a file with no better match. */
export const FALLBACK_LOOK = "neutral:Text";
export const FALLBACK_LOOK_BINARY = "neutral:Dashed";
export const FALLBACK_LOOK_CODE = "neutral:Code";

/** Folder rows: name list -> accent family and the inner glyph (a Phosphor icon name from FOLDER_GLYPHS). */
export interface FolderRow {
    id: string;
    family: Family;
    glyph: string;
    names: string;
}

export const FOLDERS: readonly FolderRow[] = [
    { id: "src", family: "blue", glyph: "Code", names: "src source sources lib libs" },
    { id: "app", family: "indigo", glyph: "AppWindow", names: "app apps pages routes views screens" },
    { id: "components", family: "cyan", glyph: "Cube", names: "components component ui widgets" },
    { id: "hooks", family: "purple", glyph: "Plugs", names: "hooks composables" },
    { id: "utils", family: "neutral", glyph: "Wrench", names: "utils util helpers common shared core" },
    {
        id: "types",
        family: "blue",
        glyph: "BracketsAngle",
        names: "types typings interfaces schemas schema models entities",
    },
    {
        id: "services",
        family: "teal",
        glyph: "GearSix",
        names: "services service providers controllers handlers middleware",
    },
    { id: "api", family: "green", glyph: "Globe", names: "api apis rest graphql rpc routes.api" },
    { id: "server", family: "green", glyph: "HardDrives", names: "server backend back-end" },
    { id: "client", family: "cyan", glyph: "Browser", names: "client frontend front-end web www site" },
    {
        id: "packages",
        family: "orange",
        glyph: "Package",
        names: "packages modules crates workspaces plugins extensions addons",
    },
    {
        id: "tests",
        family: "green",
        glyph: "Flask",
        names: "test tests __tests__ spec specs e2e integration cypress playwright __mocks__ mocks fixtures __snapshots__",
    },
    { id: "docs", family: "blue", glyph: "BookOpen", names: "docs doc documentation wiki guides man" },
    {
        id: "examples",
        family: "yellow",
        glyph: "Lightbulb",
        names: "examples example demo demos samples sandbox playground",
    },
    { id: "scripts", family: "green", glyph: "Terminal", names: "scripts script tools tooling bin cli tasks" },
    { id: "config", family: "neutral", glyph: "Gear", names: "config configs configuration conf settings .config etc" },
    {
        id: "build",
        family: "orange",
        glyph: "Hammer",
        names: "dist build out output target release releases .next .nuxt .output .svelte-kit .turbo .parcel-cache _build",
    },
    {
        id: "deps",
        family: "red",
        glyph: "Package",
        names: "node_modules vendor bower_components jspm_packages .pnpm-store .yarn .cargo .gradle .m2 pods",
    },
    {
        id: "cache",
        family: "neutral",
        glyph: "Clock",
        names: ".cache cache tmp temp .tmp .temp __pycache__ .pytest_cache .mypy_cache .ruff_cache coverage .nyc_output .coverage htmlcov",
    },
    {
        id: "env",
        family: "yellow",
        glyph: "Key",
        names: "env .env venv .venv virtualenv .virtualenv envs secrets .secrets",
    },
    { id: "git", family: "orange", glyph: "GitBranch", names: ".git .github-private .gitlab .gitea .hg .svn" },
    { id: "github", family: "neutral", glyph: "GitBranch", names: ".github" },
    {
        id: "workflows",
        family: "green",
        glyph: "ArrowsClockwise",
        names: "workflows .circleci .buildkite ci .ci .travis pipelines actions",
    },
    { id: "editor", family: "blue", glyph: "Code", names: ".vscode .idea .vs .fleet .zed .cursor .claude .agents" },
    { id: "husky", family: "neutral", glyph: "Lock", names: ".husky .githooks hooks.d" },
    { id: "public", family: "cyan", glyph: "Globe", names: "public static www-root wwwroot webroot" },
    { id: "assets", family: "purple", glyph: "Palette", names: "assets asset resources res media" },
    {
        id: "images",
        family: "purple",
        glyph: "Image",
        names: "images image img imgs pictures photos screenshots icons logos",
    },
    { id: "fonts", family: "neutral", glyph: "TextAa", names: "fonts font typefaces" },
    { id: "audio", family: "pink", glyph: "MusicNotes", names: "audio sounds sound music" },
    { id: "video", family: "pink", glyph: "FilmStrip", names: "video videos movies clips" },
    { id: "styles", family: "pink", glyph: "Palette", names: "styles style css scss sass less themes theme" },
    {
        id: "i18n",
        family: "teal",
        glyph: "Translate",
        names: "i18n l10n locales locale lang langs languages translations messages intl",
    },
    { id: "templates", family: "teal", glyph: "Layout", names: "templates template layouts partials snippets" },
    {
        id: "db",
        family: "cyan",
        glyph: "Database",
        names: "db database databases migrations migrate seeds seeders prisma drizzle sql",
    },
    { id: "data", family: "teal", glyph: "Table", names: "data datasets dataset csv json storage store state redux" },
    { id: "logs", family: "neutral", glyph: "ListBullets", names: "logs log" },
    { id: "docker", family: "blue", glyph: "Cube", names: "docker .docker containers" },
    {
        id: "k8s",
        family: "blue",
        glyph: "Cloud",
        names: "k8s kubernetes helm charts manifests deploy deployment infra infrastructure terraform ansible .terraform",
    },
    { id: "android", family: "green", glyph: "DeviceMobile", names: "android ios mobile flutter" },
    { id: "private", family: "red", glyph: "Lock", names: "private auth security keys certs certificates ssl" },
    { id: "trash", family: "neutral", glyph: "Trash", names: "trash .trash archive archives old backup backups bak" },
    { id: "uploads", family: "cyan", glyph: "UploadSimple", names: "uploads upload downloads download inbox" },
];

/** Inner glyph names the folder variants may use. Kept as data so the component imports each one by name. */
export const FOLDER_GLYPH_NAMES = [...new Set(FOLDERS.map((f) => f.glyph))] as const;
