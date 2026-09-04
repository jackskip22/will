// Will/1 Markdown text-binding host.
// Written from WILL-1.md and VECTORS.json alone.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strings"
	"unicode/utf8"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "usage: %s check VECTORS.json | parse <file>|- | evaluate <file.md>|- <act.json> [--authoring] | --adapter\n", os.Args[0])
		os.Exit(2)
	}
	switch os.Args[1] {
	case "check":
		if len(os.Args) != 3 {
			fmt.Fprintf(os.Stderr, "usage: %s check VECTORS.json\n", os.Args[0])
			os.Exit(2)
		}
		os.Exit(runCheck(os.Args[2]))
	case "parse":
		if len(os.Args) != 3 {
			fmt.Fprintf(os.Stderr, "usage: %s parse <file>|-\n", os.Args[0])
			os.Exit(2)
		}
		b, err := readArgFile(os.Args[2])
		if err != nil {
			fmt.Fprintf(os.Stderr, "read: %v\n", err)
			os.Exit(1)
		}
		writeJSON(parseBytes(b))
	case "evaluate":
		if len(os.Args) < 4 {
			fmt.Fprintf(os.Stderr, "usage: %s evaluate <file.md>|- <act-or-splices.json> [--authoring]\n", os.Args[0])
			os.Exit(2)
		}
		doc, err := readArgFile(os.Args[2])
		if err != nil {
			fmt.Fprintf(os.Stderr, "read: %v\n", err)
			os.Exit(1)
		}
		actRaw, err := os.ReadFile(os.Args[3])
		if err != nil {
			fmt.Fprintf(os.Stderr, "read act: %v\n", err)
			os.Exit(1)
		}
		path, splices, given := parseActArg(actRaw, os.Args[4:])
		writeJSON(evaluate(doc, splices, path, given))
	case "--adapter":
		os.Exit(runAdapter())
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", os.Args[1])
		os.Exit(2)
	}
}

func readArgFile(p string) ([]byte, error) {
	if p == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(p)
}

func writeJSON(v interface{}) {
	out, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal: %v\n", err)
		os.Exit(1)
	}
	os.Stdout.Write(out)
	os.Stdout.Write([]byte("\n"))
}

func parseActArg(actRaw []byte, extra []string) (path string, splices json.RawMessage, pathGiven bool) {
	authoring := false
	for _, a := range extra {
		if a == "--authoring" {
			authoring = true
		}
	}
	trim := bytes.TrimSpace(actRaw)
	if len(trim) > 0 && trim[0] == '[' {
		path = "working"
		if authoring {
			path = "authoring"
		}
		return path, json.RawMessage(trim), true
	}
	var act map[string]json.RawMessage
	if err := json.Unmarshal(actRaw, &act); err != nil {
		fmt.Fprintf(os.Stderr, "act.json: %v\n", err)
		os.Exit(1)
	}
	if raw, ok := act["path"]; ok && string(raw) != "null" {
		pathGiven = true
		_ = json.Unmarshal(raw, &path)
	}
	if authoring {
		path = "authoring"
		pathGiven = true
	}
	return path, act["splices"], pathGiven
}

func runAdapter() int {
	dec := json.NewDecoder(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	for {
		var fix map[string]json.RawMessage
		if err := dec.Decode(&fix); err != nil {
			if err == io.EOF {
				return 0
			}
			fmt.Fprintf(os.Stderr, "adapter: %v\n", err)
			return 1
		}
		id := jsonString(fix["id"])
		kind := jsonString(fix["kind"])
		var result interface{}
		switch kind {
		case "parse":
			result = parseBytes(fixtureBytes(fix, "doc", "docBase64"))
		case "evaluate":
			_, pathGiven := fix["path"]
			if pathGiven && string(fix["path"]) == "null" {
				pathGiven = false
			}
			result = evaluate(fixtureBytes(fix, "before", "beforeBase64"), fix["splices"], jsonString(fix["path"]), pathGiven)
		default:
			fmt.Fprintf(os.Stderr, "adapter: unknown kind %q\n", kind)
			return 1
		}
		if err := enc.Encode(map[string]interface{}{"id": id, "kind": kind, "result": result}); err != nil {
			fmt.Fprintf(os.Stderr, "adapter encode: %v\n", err)
			return 1
		}
	}
}

func jsonString(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}

func fixtureBytes(fix map[string]json.RawMessage, plain, b64 string) []byte {
	if v, ok := fix[b64]; ok && len(v) > 0 && string(v) != "null" {
		var s string
		if err := json.Unmarshal(v, &s); err == nil {
			if b, err := base64.StdEncoding.DecodeString(s); err == nil {
				return b
			}
		}
	}
	if v, ok := fix[plain]; ok && len(v) > 0 && string(v) != "null" {
		var s string
		if err := json.Unmarshal(v, &s); err == nil {
			return []byte(s)
		}
	}
	return []byte{}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ParseResult struct {
	Faulted bool     `json:"faulted"`
	Faults  []Fault  `json:"faults"`
	Regions []Region `json:"regions"`
}

type Fault struct {
	Mode     string `json:"mode"`
	Line     *int   `json:"line"`
	ByteSpan [2]int `json:"byteSpan"`
}

type MarkerPos struct {
	Line     int    `json:"line"`
	ByteSpan [2]int `json:"byteSpan"`
}

type Region struct {
	Index        int       `json:"index"`
	Law          string    `json:"law"`
	Intent       *string   `json:"intent"`
	Opener       MarkerPos `json:"opener"`
	Closer       MarkerPos `json:"closer"`
	GovernedSpan [2]int    `json:"governedSpan"`
}

type Outcome struct {
	Outcome string  `json:"outcome"`
	Reason  string  `json:"reason,omitempty"`
	Rule    string  `json:"rule,omitempty"`
	Region  *int    `json:"region,omitempty"`
	Law     string  `json:"law,omitempty"`
	Faults  []Fault `json:"faults,omitempty"`
}

type Splice struct {
	Start  int
	End    int
	Insert []byte
}

type lineRec struct {
	n          int
	start, end int
	content    string
	raw        []byte
}

type markerKind int

const (
	mkNone markerKind = iota
	mkOpener
	mkCloser
	mkFault
)

type classified struct {
	kind   markerKind
	mode   string
	law    string
	intent *string
	line   int
	span   [2]int
}

var knownLaws = map[string]bool{"edit": true, "append": true, "keep": true}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

func splitLines(b []byte) []lineRec {
	var out []lineRec
	n := 0
	i := 0
	for i < len(b) {
		start := i
		for i < len(b) && b[i] != '\n' {
			i++
		}
		if i < len(b) && b[i] == '\n' {
			i++
		}
		raw := b[start:i]
		out = append(out, lineRec{n: n, start: start, end: i, content: lineContent(raw), raw: raw})
		n++
	}
	return out
}

func lineContent(raw []byte) string {
	if bytes.HasSuffix(raw, []byte("\r\n")) {
		return string(raw[:len(raw)-2])
	}
	if bytes.HasSuffix(raw, []byte("\n")) {
		return string(raw[:len(raw)-1])
	}
	return string(raw)
}

func stripTrailingTerminator(b []byte) []byte {
	if bytes.HasSuffix(b, []byte("\r\n")) {
		return b[:len(b)-2]
	}
	if bytes.HasSuffix(b, []byte("\n")) {
		return b[:len(b)-1]
	}
	return b
}

// ---------------------------------------------------------------------------
// Strict UTF-8
//
// The first malformed sequence is one fault and reading stops. Sequence
// length follows the lead byte's UTF-8 bit-pattern (110xxxxx → 2, 1110xxxx → 3,
// 11110xxx → 4, anything else as a lead → 1). A complete would-be sequence
// whose trailing bytes are all continuations is reported whole when it is not
// well-formed per Unicode Table 3-7; a complete would-be sequence that
// contains a non-continuation is reported as the lead byte only; a truncated
// sequence at EOF is reported as every remaining byte.
// ---------------------------------------------------------------------------

func firstInvalidUTF8(b []byte) (int, int) {
	i := 0
	for i < len(b) {
		c := b[i]
		if c <= 0x7F {
			i++
			continue
		}
		need := utf8Need(c)
		have := len(b) - i
		if have < need {
			// truncated at EOF: every remaining byte is the malformed sequence
			return i, len(b)
		}
		allCont := true
		for k := 1; k < need; k++ {
			if b[i+k]&0xC0 != 0x80 {
				allCont = false
				break
			}
		}
		if !allCont {
			// a non-continuation appeared inside a complete would-be sequence:
			// the lead itself is the malformed sequence.
			return i, i + 1
		}
		if utf8WellFormed(b[i : i+need]) {
			i += need
			continue
		}
		return i, i + need
	}
	return -1, -1
}

func utf8Need(c byte) int {
	switch {
	case c <= 0x7F:
		return 1
	case c >= 0xC0 && c <= 0xDF:
		return 2
	case c >= 0xE0 && c <= 0xEF:
		return 3
	case c >= 0xF0 && c <= 0xF7:
		return 4
	default:
		// 80–BF continuation-as-lead, F8–FF
		return 1
	}
}

// utf8WellFormed reports whether seq (length = utf8Need(seq[0]), all trailing
// bytes continuations) is a well-formed UTF-8 character per Unicode Table 3-7.
func utf8WellFormed(seq []byte) bool {
	c := seq[0]
	switch {
	case c >= 0xC2 && c <= 0xDF:
		return len(seq) == 2
	case c == 0xE0:
		return len(seq) == 3 && seq[1] >= 0xA0 && seq[1] <= 0xBF
	case c >= 0xE1 && c <= 0xEC:
		return len(seq) == 3
	case c == 0xED:
		return len(seq) == 3 && seq[1] >= 0x80 && seq[1] <= 0x9F
	case c == 0xEE || c == 0xEF:
		return len(seq) == 3
	case c == 0xF0:
		return len(seq) == 4 && seq[1] >= 0x90 && seq[1] <= 0xBF
	case c >= 0xF1 && c <= 0xF3:
		return len(seq) == 4
	case c == 0xF4:
		return len(seq) == 4 && seq[1] >= 0x80 && seq[1] <= 0x8F
	default:
		return false
	}
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

func parseBytes(b []byte) ParseResult {
	res := ParseResult{Faults: []Fault{}, Regions: []Region{}}
	if s, e := firstInvalidUTF8(b); s >= 0 {
		res.Faulted = true
		res.Faults = []Fault{{Mode: "invalid_utf8", Line: nil, ByteSpan: [2]int{s, e}}}
		return res
	}
	lines := splitLines(b)
	faults := make([]Fault, 0)
	regions := make([]Region, 0)
	var pending *classified
	for _, ln := range lines {
		cl := classifyLine(ln)
		if cl.kind == mkNone {
			continue
		}
		switch cl.kind {
		case mkOpener:
			if pending != nil {
				faults = append(faults, Fault{Mode: "unpaired_marker", Line: intPtr(cl.line), ByteSpan: cl.span})
			} else {
				cp := cl
				pending = &cp
			}
		case mkCloser:
			if pending != nil {
				regions = append(regions, Region{
					Index:        len(regions),
					Law:          pending.law,
					Intent:       pending.intent,
					Opener:       MarkerPos{Line: pending.line, ByteSpan: pending.span},
					Closer:       MarkerPos{Line: cl.line, ByteSpan: cl.span},
					GovernedSpan: [2]int{pending.span[1], cl.span[0]},
				})
				pending = nil
			} else {
				faults = append(faults, Fault{Mode: "unpaired_marker", Line: intPtr(cl.line), ByteSpan: cl.span})
			}
		case mkFault:
			faults = append(faults, Fault{Mode: cl.mode, Line: intPtr(cl.line), ByteSpan: cl.span})
		}
	}
	if pending != nil {
		faults = append(faults, Fault{Mode: "unpaired_marker", Line: intPtr(pending.line), ByteSpan: pending.span})
	}
	sort.SliceStable(faults, func(i, j int) bool {
		return faults[i].ByteSpan[0] < faults[j].ByteSpan[0]
	})
	res.Faults = faults
	res.Regions = regions
	res.Faulted = len(faults) > 0
	return res
}

func intPtr(n int) *int { return &n }

func classifyLine(ln lineRec) classified {
	c := ln.content
	base := classified{line: ln.n, span: [2]int{ln.start, ln.end}}

	unspacedOpener := strings.HasPrefix(c, "<!--will/")
	unspacedCloser := strings.HasPrefix(c, "<!--/will")
	spacedOpener := strings.HasPrefix(c, "<!-- will/")
	spacedCloser := strings.HasPrefix(c, "<!-- /will")

	if !unspacedOpener && !unspacedCloser && !spacedOpener && !spacedCloser {
		base.kind = mkNone
		return base
	}
	if unspacedOpener || unspacedCloser {
		base.kind = mkFault
		base.mode = "malformed_marker"
		return base
	}
	if spacedCloser {
		return classifyCloser(c, base)
	}
	return classifyOpener(c, base)
}

func classifyCloser(c string, base classified) classified {
	if c == "<!-- /will -->" {
		base.kind = mkCloser
		return base
	}
	base.kind = mkFault
	base.mode = "malformed_marker"
	return base
}

func classifyOpener(c string, base classified) classified {
	// Version is judged first on the marker line.
	rest := c[len("<!-- will/"):]
	verEnd := 0
	for verEnd < len(rest) && rest[verEnd] != ' ' {
		verEnd++
	}
	version := rest[:verEnd]
	if version != "1" {
		base.kind = mkFault
		base.mode = "unknown_version"
		return base
	}

	idx := strings.Index(c, "-->")
	if idx < 0 || idx+3 != len(c) {
		base.kind = mkFault
		base.mode = "malformed_marker"
		return base
	}
	interior := c[:idx]

	afterVer := interior[len("<!-- will/"):]
	i := 0
	for i < len(afterVer) && afterVer[i] != ' ' {
		i++
	}
	if i >= len(afterVer) || afterVer[i] != ' ' {
		base.kind = mkFault
		base.mode = "malformed_marker"
		return base
	}
	remaining := afterVer[i+1:]
	if remaining == "" {
		base.kind = mkFault
		base.mode = "malformed_marker"
		return base
	}

	tokEnd := 0
	for tokEnd < len(remaining) && remaining[tokEnd] != ' ' {
		tokEnd++
	}
	token := remaining[:tokEnd]

	// Shape around the law token is judged before the law word itself:
	// the token must be followed by " -->" (no-intent) or ": <intent> -->".
	bareForm := remaining == token+" "
	colonForm := strings.HasSuffix(token, ":") && tokEnd < len(remaining) && remaining[tokEnd] == ' ' && strings.HasSuffix(remaining, " ") && tokEnd+1 <= len(remaining)-1

	if bareForm {
		if knownLaws[token] {
			base.kind = mkOpener
			base.law = token
			base.intent = nil
			return base
		}
		if token != "" && !strings.Contains(token, ":") {
			base.kind = mkFault
			base.mode = "unknown_law"
			return base
		}
		base.kind = mkFault
		base.mode = "malformed_marker"
		return base
	}

	if colonForm {
		lawCand := token[:len(token)-1]
		intent := remaining[tokEnd+1 : len(remaining)-1]
		if knownLaws[lawCand] {
			if intent == "" || strings.Contains(intent, "--") {
				base.kind = mkFault
				base.mode = "malformed_marker"
				return base
			}
			if utf8.RuneCountInString(intent) > 512 {
				base.kind = mkFault
				base.mode = "intent_over_bound"
				return base
			}
			base.kind = mkOpener
			base.law = lawCand
			s := intent
			base.intent = &s
			return base
		}
		if lawCand != "" && !strings.Contains(lawCand, ":") {
			base.kind = mkFault
			base.mode = "unknown_law"
			return base
		}
		base.kind = mkFault
		base.mode = "malformed_marker"
		return base
	}

	base.kind = mkFault
	base.mode = "malformed_marker"
	return base
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

func evaluate(before []byte, splicesRaw json.RawMessage, path string, pathGiven bool) Outcome {
	if !pathGiven {
		path = "working"
	}
	if path != "working" && path != "authoring" {
		return invalid("unknown_path")
	}
	splices, rule := readSplices(splicesRaw, len(before))
	if rule != "" {
		return invalid(rule)
	}

	if path == "authoring" {
		return Outcome{Outcome: "applied"}
	}

	beforeParse := parseBytes(before)
	if beforeParse.Faulted {
		if len(splices) == 0 {
			return Outcome{Outcome: "applied"}
		}
		return Outcome{
			Outcome: "refused",
			Reason:  "document_law",
			Rule:    "before_faulted",
			Faults:  beforeParse.Faults,
		}
	}

	if ridx, law, ok := firstMarkerTouch(beforeParse, splices); ok {
		return Outcome{
			Outcome: "refused",
			Reason:  "document_law",
			Rule:    "marker_span_touched",
			Region:  intPtr(ridx),
			Law:     law,
		}
	}

	after := applySplices(before, splices)
	afterParse := parseBytes(after)

	if afterParse.Faulted {
		return Outcome{
			Outcome: "refused",
			Reason:  "document_law",
			Rule:    "result_faulted",
			Faults:  afterParse.Faults,
		}
	}

	if !sameRegionSequence(beforeParse.Regions, afterParse.Regions) {
		return Outcome{
			Outcome: "refused",
			Reason:  "document_law",
			Rule:    "marker_sequence_mismatch",
		}
	}

	if ridx, law, ok := firstLawViolation(before, after, beforeParse.Regions, afterParse.Regions); ok {
		return Outcome{
			Outcome: "refused",
			Reason:  "document_law",
			Rule:    "law_violated",
			Region:  intPtr(ridx),
			Law:     law,
		}
	}
	return Outcome{Outcome: "applied"}
}

func invalid(rule string) Outcome {
	return Outcome{Outcome: "invalid", Reason: "precondition", Rule: rule}
}

func sameRegionSequence(a, b []Region) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Law != b[i].Law {
			return false
		}
		if (a[i].Intent == nil) != (b[i].Intent == nil) {
			return false
		}
		if a[i].Intent != nil && b[i].Intent != nil && *a[i].Intent != *b[i].Intent {
			return false
		}
	}
	return true
}

func firstMarkerTouch(p ParseResult, splices []Splice) (int, string, bool) {
	type hit struct {
		region int
		law    string
		at     int
	}
	var hits []hit
	for ri, r := range p.Regions {
		spans := [][2]int{r.Opener.ByteSpan, r.Closer.ByteSpan}
		for _, spn := range spans {
			for _, sp := range splices {
				if rangesOverlap(sp.Start, sp.End, spn[0], spn[1]) {
					hits = append(hits, hit{region: ri, law: r.Law, at: spn[0]})
					break
				}
			}
		}
	}
	if len(hits) == 0 {
		return 0, "", false
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].region != hits[j].region {
			return hits[i].region < hits[j].region
		}
		return hits[i].at < hits[j].at
	})
	return hits[0].region, hits[0].law, true
}

func rangesOverlap(a0, a1, b0, b1 int) bool {
	return a0 < b1 && b0 < a1
}

func firstLawViolation(before, after []byte, oldR, newR []Region) (int, string, bool) {
	for i := range oldR {
		oldG := before[oldR[i].GovernedSpan[0]:oldR[i].GovernedSpan[1]]
		newG := after[newR[i].GovernedSpan[0]:newR[i].GovernedSpan[1]]
		law := oldR[i].Law
		switch law {
		case "keep":
			if !bytes.Equal(oldG, newG) {
				return i, law, true
			}
		case "append":
			oldP := stripTrailingTerminator(oldG)
			newP := stripTrailingTerminator(newG)
			if !bytes.HasPrefix(newP, oldP) {
				return i, law, true
			}
		}
	}
	return 0, "", false
}

func applySplices(doc []byte, splices []Splice) []byte {
	if len(splices) == 0 {
		out := make([]byte, len(doc))
		copy(out, doc)
		return out
	}
	ss := append([]Splice(nil), splices...)
	sort.Slice(ss, func(i, j int) bool { return ss[i].Start > ss[j].Start })
	out := doc
	for _, sp := range ss {
		n := make([]byte, 0, len(out)-(sp.End-sp.Start)+len(sp.Insert))
		n = append(n, out[:sp.Start]...)
		n = append(n, sp.Insert...)
		n = append(n, out[sp.End:]...)
		out = n
	}
	return out
}

func overlapping(splices []Splice) bool {
	for i := 0; i < len(splices); i++ {
		for j := i + 1; j < len(splices); j++ {
			a, b := splices[i], splices[j]
			if a.Start == b.Start {
				return true
			}
			if a.Start < b.End && b.Start < a.End {
				return true
			}
		}
	}
	return false
}

func readSplices(raw json.RawMessage, docLen int) ([]Splice, string) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, "malformed_splice"
	}
	var arr []interface{}
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil, "malformed_splice"
	}
	out := make([]Splice, 0, len(arr))
	for _, el := range arr {
		if el == nil {
			return nil, "malformed_splice"
		}
		obj, ok := el.(map[string]interface{})
		if !ok {
			return nil, "malformed_splice"
		}
		start, ok := asNonNegInt(obj["start"])
		if !ok {
			return nil, "malformed_splice"
		}
		end, ok := asNonNegInt(obj["end"])
		if !ok {
			return nil, "malformed_splice"
		}
		if start > end {
			return nil, "malformed_splice"
		}
		ins, ok := insertBytes(obj)
		if !ok {
			return nil, "malformed_splice"
		}
		if start > docLen || end > docLen {
			return nil, "out_of_range_splice"
		}
		out = append(out, Splice{Start: start, End: end, Insert: ins})
	}
	if overlapping(out) {
		return nil, "overlapping_splices"
	}
	return out, ""
}

func asNonNegInt(v interface{}) (int, bool) {
	if v == nil {
		return 0, false
	}
	switch n := v.(type) {
	case float64:
		if n < 0 || math.Trunc(n) != n || n > float64(math.MaxInt32) {
			return 0, false
		}
		return int(n), true
	case json.Number:
		f, err := n.Float64()
		if err != nil {
			return 0, false
		}
		if f < 0 || math.Trunc(f) != f || f > float64(math.MaxInt32) {
			return 0, false
		}
		return int(f), true
	default:
		return 0, false
	}
}

func insertBytes(obj map[string]interface{}) ([]byte, bool) {
	if v, ok := obj["insertBase64"]; ok {
		s, ok := v.(string)
		if !ok {
			return nil, false
		}
		b, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			return nil, false
		}
		return b, true
	}
	if v, ok := obj["insert"]; ok {
		s, ok := v.(string)
		if !ok {
			return nil, false
		}
		return []byte(s), true
	}
	return nil, false
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

type vectorFile struct {
	Vectors []vector `json:"vectors"`
}

type vector struct {
	ID        string          `json:"id"`
	Kind      string          `json:"kind"`
	Note      string          `json:"note"`
	Doc       *string         `json:"doc"`
	DocBase64 *string         `json:"docBase64"`
	Path      string          `json:"path"`
	Before    *string         `json:"before"`
	BeforeB64 *string         `json:"beforeBase64"`
	Splices   json.RawMessage `json:"splices"`
	Expect    json.RawMessage `json:"expect"`
}

func runCheck(path string) int {
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read vectors: %v\n", err)
		return 1
	}
	var vf vectorFile
	if err := json.Unmarshal(raw, &vf); err != nil {
		fmt.Fprintf(os.Stderr, "vectors json: %v\n", err)
		return 1
	}
	pass, fail := 0, 0
	for _, v := range vf.Vectors {
		var got interface{}
		switch v.Kind {
		case "parse":
			doc, err := vecBytes(v.Doc, v.DocBase64)
			if err != nil {
				fmt.Printf("FAIL %s: %v\n", v.ID, err)
				fail++
				continue
			}
			got = parseBytes(doc)
		case "evaluate":
			before, err := vecBytes(v.Before, v.BeforeB64)
			if err != nil {
				fmt.Printf("FAIL %s: %v\n", v.ID, err)
				fail++
				continue
			}
			got = evaluate(before, v.Splices, v.Path, true)
		default:
			fmt.Printf("FAIL %s: unknown kind %q\n", v.ID, v.Kind)
			fail++
			continue
		}
		gotJSON, err := json.Marshal(got)
		if err != nil {
			fmt.Printf("FAIL %s: marshal: %v\n", v.ID, err)
			fail++
			continue
		}
		var gotV, expV interface{}
		if err := json.Unmarshal(gotJSON, &gotV); err != nil {
			fmt.Printf("FAIL %s: unmarshal got: %v\n", v.ID, err)
			fail++
			continue
		}
		if err := json.Unmarshal(v.Expect, &expV); err != nil {
			fmt.Printf("FAIL %s: unmarshal expect: %v\n", v.ID, err)
			fail++
			continue
		}
		if !jsonEqual(gotV, expV) {
			fmt.Printf("FAIL %s (%s)\n  note: %s\n  got:    %s\n  expect: %s\n  diff:   %s\n",
				v.ID, v.Kind, v.Note, compact(gotJSON), compact(v.Expect), jsonDiff(gotV, expV, ""))
			fail++
			continue
		}
		pass++
	}
	fmt.Printf("%d pass / %d fail\n", pass, fail)
	if fail != 0 {
		return 1
	}
	return 0
}

func vecBytes(plain, b64 *string) ([]byte, error) {
	if b64 != nil {
		return base64.StdEncoding.DecodeString(*b64)
	}
	if plain != nil {
		return []byte(*plain), nil
	}
	return nil, fmt.Errorf("missing doc/before bytes")
}

func compact(b []byte) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, b); err != nil {
		return string(b)
	}
	return buf.String()
}

func jsonEqual(a, b interface{}) bool {
	switch av := a.(type) {
	case map[string]interface{}:
		bv, ok := b.(map[string]interface{})
		if !ok || len(av) != len(bv) {
			return false
		}
		for k, v := range av {
			bv2, ok := bv[k]
			if !ok || !jsonEqual(v, bv2) {
				return false
			}
		}
		return true
	case []interface{}:
		bv, ok := b.([]interface{})
		if !ok || len(av) != len(bv) {
			return false
		}
		for i := range av {
			if !jsonEqual(av[i], bv[i]) {
				return false
			}
		}
		return true
	case float64:
		bv, ok := b.(float64)
		return ok && av == bv
	case string:
		bv, ok := b.(string)
		return ok && av == bv
	case bool:
		bv, ok := b.(bool)
		return ok && av == bv
	case nil:
		return b == nil
	default:
		return false
	}
}

func jsonDiff(got, exp interface{}, path string) string {
	if jsonEqual(got, exp) {
		return ""
	}
	gm, gok := got.(map[string]interface{})
	em, eok := exp.(map[string]interface{})
	if gok && eok {
		var parts []string
		for k := range em {
			if _, ok := gm[k]; !ok {
				parts = append(parts, fmt.Sprintf("%s.%s missing in got", path, k))
			} else if d := jsonDiff(gm[k], em[k], path+"."+k); d != "" {
				parts = append(parts, d)
			}
		}
		for k := range gm {
			if _, ok := em[k]; !ok {
				parts = append(parts, fmt.Sprintf("%s.%s extra in got", path, k))
			}
		}
		return strings.Join(parts, "; ")
	}
	gs, gok := got.([]interface{})
	es, eok := exp.([]interface{})
	if gok && eok {
		if len(gs) != len(es) {
			return fmt.Sprintf("%s: len got %d expect %d", path, len(gs), len(es))
		}
		var parts []string
		for i := range gs {
			if d := jsonDiff(gs[i], es[i], fmt.Sprintf("%s[%d]", path, i)); d != "" {
				parts = append(parts, d)
			}
		}
		return strings.Join(parts, "; ")
	}
	return fmt.Sprintf("%s: got %v (%T) expect %v (%T)", path, got, got, exp, exp)
}
