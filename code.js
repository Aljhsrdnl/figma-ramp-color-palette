// themeColors publishes Figma's --figma-color-* variables into the UI iframe and
// tags <html> with figma-dark/figma-light, which is what lets the panel follow
// the editor's theme. It's a showUI option, not a manifest field.
// Taller than the default 480: the form now has a pinned action footer, so the
// height buys visible hex rows rather than just a longer scroll.
figma.showUI(__html__, { width: 320, height: 560, themeColors: true });

// A drawn sheet is identified by its frame name, which is how a later run
// finds and replaces its own output instead of stacking a new sheet on top.
//
// The obvious alternative, setPluginData, is *private* plugin data keyed to the
// plugin's manifest id — and a development plugin imported from a hand-written
// manifest has no id, so it throws outright. Naming works with no id and no
// manifest change. The tradeoff: rename or duplicate a sheet frame and the next
// run no longer recognises it, drawing a fresh one instead of replacing.
//
// The name is bare "<collection>/<ramp>" because it shows on canvas above the
// card and doubles as the sheet's only title. It carried a "Ramp Variables — "
// prefix until 2026-08-11, which made it unmistakably ours; without it, any
// unrelated frame a person happens to name "Colors/gray" on the current page
// will be treated as an old sheet and removed. Accepted: the label being clean
// is worth more here than the namespace.
function sheetNameFor(collectionName, ramp) {
  return collectionName + "/" + ramp;
}

const SHEET_BG = "#1A1A1A";
const SWATCH_W = 167;
const SWATCH_H = 108;
const CHIP_TEXT = 14;

const SHEET_FONT = { family: "Mona Sans", style: "Regular" };
// Inter ships with Figma; Mona Sans has to be installed locally, so a machine
// without it would otherwise fail the whole run at loadFontAsync.
const FALLBACK_FONT = { family: "Inter", style: "Regular" };

async function loadSheetFont() {
  try {
    await figma.loadFontAsync(SHEET_FONT);
    return SHEET_FONT;
  } catch (err) {
    await figma.loadFontAsync(FALLBACK_FONT);
    figma.notify("Mona Sans not found — sheet drawn in Inter instead.");
    return FALLBACK_FONT;
  }
}

function solid(hex) {
  return { type: "SOLID", color: figma.util.rgb(hex) };
}

// Figma paints carry float RGB; the hex field and figma.util.rgb() want #RRGGBB.
function toHex(color) {
  const channel = (c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0");
  return "#" + channel(color.r) + channel(color.g) + channel(color.b);
}

// The first solid fill on the selection, as hex. Walks the selection in order
// and takes the first usable paint rather than insisting on a single selection —
// picking a color is low-stakes, so guessing beats refusing.
//
// Skipped deliberately: nodes with no fills property (groups, sections),
// figma.mixed (text with per-character colors), non-solid paints, layers
// hidden in the layers panel, and paints at opacity 0. Paint opacity
// otherwise ignored — a partly transparent paint is sampled at full strength,
// because compositing it against the canvas needs a backdrop we cannot know.
// That is a different claim from opacity 0: a fully transparent paint is not
// partly visible, it is invisible, and sampling it is indefensible, so it is
// excluded rather than composited.
//
// figma.currentPage.selection is scene-graph ordered, not click ordered, so
// with a multi-select this does not sample "the last thing I clicked".
//
// Unverified, and it only matters for stacked fills: which end of the fills
// array Figma paints on top. If a multi-fill layer ever samples the "wrong"
// one, that is the reason.
function solidFillHex() {
  for (const node of figma.currentPage.selection) {
    if (node.visible === false) continue;
    if (!("fills" in node)) continue;
    const fills = node.fills;
    if (fills === figma.mixed) continue;
    for (const paint of fills) {
      if (paint.type === "SOLID" && paint.visible !== false && paint.opacity !== 0) {
        return toHex(paint.color);
      }
    }
  }
  return null;
}

// Picks a label colour the step number stays readable in, at both ends of the
// ramp: near-white swatches get near-black text and vice versa. Relative
// luminance per WCAG, not a naive channel average — #FFFF00 is far brighter
// than its mean suggests.
//
// 0.179 is the crossover, not an eyeballed guess: it's where a swatch's
// contrast ratio against black equals its ratio against white (both 4.58:1).
// Above it black wins, below it white does. Picking 0.5 would put mid-greys
// like #A5A5A5 on white text at 2.5:1 when black would have given 8.5:1.
const LABEL_FLIP = 0.179;

function labelColorFor(hex) {
  const channel = (offset) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance =
    0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // Pure black and pure white deliberately: softening the dark label to
  // #121212 drops the worst-case step (a mid-grey right at the crossover)
  // from 4.69:1 to 4.12:1, under the 4.5:1 floor for text this size.
  return luminance > LABEL_FLIP
    ? { r: 0, g: 0, b: 0 }
    : { r: 1, g: 1, b: 1 };
}

function label(text, size, font, color) {
  const node = figma.createText();
  node.fontName = font;
  node.fontSize = size;
  node.characters = text;
  node.fills = [{ type: "SOLID", color: color }];
  return node;
}

// Draws the documentation sheet: a dark card holding one labelled chip per
// step, with each chip's fill BOUND to its variable so the sheet tracks later
// edits instead of freezing today's hex values.
async function drawSheet(collection, ramp, entries, variablesByName) {
  const font = await loadSheetFont();

  const name = sheetNameFor(collection.name, ramp);

  // Look for the prior sheet BEFORE creating the new one — otherwise the new
  // frame, already parented to the page by createFrame(), matches its own name.
  const previous = figma.currentPage.findOne(
    (node) => node.type === "FRAME" && node.name === name
  );

  const sheet = figma.createFrame();
  sheet.name = name;
  sheet.layoutMode = "VERTICAL";
  sheet.primaryAxisSizingMode = "AUTO";
  sheet.counterAxisSizingMode = "AUTO";
  sheet.paddingTop = 32;
  sheet.paddingBottom = 32;
  sheet.paddingLeft = 32;
  sheet.paddingRight = 32;
  sheet.itemSpacing = 16;
  sheet.cornerRadius = 16;
  sheet.fills = [solid(SHEET_BG)];

  // No title text inside the card — the frame's own layer name, which Figma
  // draws just above it on canvas, already reads "<collection>/<ramp>".
  const row = figma.createFrame();
  row.name = "Swatches";
  row.layoutMode = "HORIZONTAL";
  row.primaryAxisSizingMode = "AUTO";
  row.counterAxisSizingMode = "AUTO";
  row.itemSpacing = 8;
  row.fills = [];
  sheet.appendChild(row);

  for (const entry of entries) {
    const chip = figma.createFrame();
    chip.name = entry.name;
    chip.layoutMode = "VERTICAL";
    chip.primaryAxisSizingMode = "FIXED";
    chip.counterAxisSizingMode = "FIXED";
    chip.resize(SWATCH_W, SWATCH_H);
    chip.primaryAxisAlignItems = "MAX";
    chip.paddingTop = 12;
    chip.paddingBottom = 12;
    chip.paddingLeft = 12;
    chip.paddingRight = 12;
    chip.itemSpacing = 2;
    chip.cornerRadius = 10;

    let paint = solid(entry.hex);
    const variable = variablesByName.get(entry.name);
    if (variable) {
      paint = figma.variables.setBoundVariableForPaint(paint, "color", variable);
    }
    chip.fills = [paint];

    const labelColor = labelColorFor(entry.hex);
    // entry.name is "<ramp>/<step>" — show just the step, the ramp is the title.
    const step = entry.name.slice(ramp.length + 1);
    chip.appendChild(label(step, CHIP_TEXT, font, labelColor));
    chip.appendChild(label(entry.hex.toUpperCase(), CHIP_TEXT, font, labelColor));

    row.appendChild(chip);
  }

  // Replace this ramp's previous sheet in place, so a sheet you dragged
  // somewhere deliberate stays where you put it. Current page only —
  // reaching other pages would need loadAllPagesAsync().
  if (previous) {
    sheet.x = previous.x;
    sheet.y = previous.y;
    previous.remove();
    return "sheet replaced";
  }
  sheet.x = Math.round(figma.viewport.center.x - sheet.width / 2);
  sheet.y = Math.round(figma.viewport.center.y - sheet.height / 2);
  return "sheet drawn";
}

figma.ui.onmessage = async (msg) => {
  // Answered here and returned early: picking a color touches no variables, so
  // it shares nothing with the create-ramp path below.
  if (msg.type === "pick-selection") {
    // This is the only main-thread path with no try/catch elsewhere in this
    // handler, because it has no status line to fall back on: the toast is
    // the only feedback, so an uncaught throw here (an unexpected node type,
    // a fills getter that raises) would be a dead-looking button rather than
    // a visible error.
    try {
      const hex = solidFillHex();
      if (!hex) {
        figma.notify(
          figma.currentPage.selection.length === 0
            ? "Select a layer with a solid fill first."
            : "No solid fill on the selection."
        );
        return;
      }
      figma.ui.postMessage({ type: "picked", hex: hex });
    } catch (err) {
      figma.notify("Couldn't read the selection's fill.");
    }
    return;
  }
  if (msg.type !== "create-ramp") return;
  let created = 0;
  let updated = 0;
  try {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    // Match by name; if several collections share it, first wins (spec).
    let collection = collections.find((c) => c.name === msg.collection);
    if (!collection) {
      collection = figma.variables.createVariableCollection(msg.collection);
    }

    // Fetch every local variable (no type filter) so a same-named
    // non-COLOR variable in this collection is visible before we write
    // anything — createVariable() would otherwise throw mid-loop on a name
    // that's already taken, after earlier entries were already written.
    const allVariables = await figma.variables.getLocalVariablesAsync();
    const inCollection = new Map();
    for (const v of allVariables) {
      if (v.variableCollectionId === collection.id) inCollection.set(v.name, v);
    }

    // Pre-flight: refuse the whole run before any create/update happens if
    // a target name is already taken by a variable of a different type.
    for (const entry of msg.entries) {
      const existing = inCollection.get(entry.name);
      if (existing && existing.resolvedType !== "COLOR") {
        throw new Error(
          entry.name + " already exists as a " + existing.resolvedType + " variable"
        );
      }
    }

    // Index this collection's existing COLOR variables by name so re-runs
    // update in place instead of duplicating.
    const byName = new Map();
    for (const v of inCollection.values()) {
      if (v.resolvedType === "COLOR") byName.set(v.name, v);
    }

    // Keyed by name, including the ones created just now — the sheet binds
    // its chip fills to these.
    const applied = new Map();
    for (const entry of msg.entries) {
      let variable = byName.get(entry.name);
      if (variable) {
        updated++;
      } else {
        variable = figma.variables.createVariable(entry.name, collection, "COLOR");
        created++;
      }
      variable.setValueForMode(collection.defaultModeId, figma.util.rgb(entry.hex));
      applied.set(entry.name, variable);
    }

    // A shrinking re-run (e.g. 11 steps, then 5) leaves earlier steps behind
    // with stale values; surface that so the summary doesn't imply a
    // smaller ramp than what's actually in the collection.
    const entryNames = new Set(msg.entries.map((e) => e.name));
    const rampPrefix = msg.ramp + "/";
    let untouched = 0;
    for (const name of inCollection.keys()) {
      if (name.indexOf(rampPrefix) === 0 && !entryNames.has(name)) untouched++;
    }

    let summary = msg.ramp + ": " + created + " created, " + updated + " updated";
    if (untouched > 0) {
      summary += " (" + untouched + " existing steps left untouched)";
    }
    if (msg.sheet) {
      summary += " + " + (await drawSheet(collection, msg.ramp, msg.entries, applied));
    }
    figma.notify(summary);
    figma.ui.postMessage({ type: "done", summary: summary });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const full = message + " (" + created + " created, " + updated + " updated before the error)";
    figma.notify(full, { error: true });
    figma.ui.postMessage({ type: "error", message: full });
  }
};
