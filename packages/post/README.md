# @estoc/post

The `https://estoc.dev/post/1.0` type format for [folder-objects](../folder-object): a post is an object whose principal bytes are authored text. Vocabulary contract: [folder-object/formats/post-1.0.md](https://github.com/estoc-net/folder-object/blob/main/formats/post-1.0.md).

Pure functions, no IO; runs in Node, workerd, and the browser.

```ts
import { isPost, validatePost, readPost, renderPost } from "@estoc/post";

isPost(object.meta);            // declares itself a post?
validatePost(object.meta);      // [] or every vocabulary violation
readPost(object.meta);          // PostMeta — needs only the index, not the bytes
renderPost(object, { assetBase: "object" });
// → { ...PostMeta, bodyHtml, assets: ["files/signer.jpg"] }
```

`renderPost` is the reference projection. It yields **parts**, never a page: the body as an HTML fragment (CommonMark via marked, raw HTML dropped, in-tree references resolved against the body's own path and prefixed with `assetBase`) plus the list of in-tree paths the body referred to. The host owns the page — the title tag, the chrome, the styles — and composes the parts into it: the app lays them into a sandboxed frame with assets inlined from the verified tree; `estoc object render` lays them into a Mustache-style template for a static site.
