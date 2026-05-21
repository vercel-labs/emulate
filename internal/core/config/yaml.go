package config

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

type yamlLine struct {
	indent int
	text   string
	line   int
}

type yamlParser struct {
	lines []yamlLine
	pos   int
}

func parseYAMLDocument(raw []byte) (map[string]json.RawMessage, error) {
	lines, err := tokenizeYAML(raw)
	if err != nil {
		return nil, err
	}
	if len(lines) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	parser := yamlParser{lines: lines}
	value, err := parser.parseBlock(lines[0].indent)
	if err != nil {
		return nil, err
	}
	if parser.pos != len(lines) {
		line := parser.lines[parser.pos]
		return nil, fmt.Errorf("unexpected YAML content on line %d", line.line)
	}
	top, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("top-level YAML config must be a mapping")
	}
	out := make(map[string]json.RawMessage, len(top))
	for key, value := range top {
		raw, err := json.Marshal(value)
		if err != nil {
			return nil, fmt.Errorf("encode %s: %w", key, err)
		}
		out[key] = raw
	}
	return out, nil
}

func tokenizeYAML(raw []byte) ([]yamlLine, error) {
	normalized := strings.ReplaceAll(string(raw), "\r\n", "\n")
	sourceLines := strings.Split(normalized, "\n")
	lines := make([]yamlLine, 0, len(sourceLines))
	for index, source := range sourceLines {
		if strings.TrimSpace(source) == "" {
			continue
		}
		withoutComment := stripYAMLComment(source)
		if strings.TrimSpace(withoutComment) == "" {
			continue
		}
		indent := leadingSpaces(withoutComment)
		if strings.Contains(withoutComment[:indent], "\t") || (indent < len(withoutComment) && withoutComment[indent] == '\t') {
			return nil, fmt.Errorf("tabs are not supported for indentation on line %d", index+1)
		}
		if indent%2 != 0 {
			return nil, fmt.Errorf("indentation must use multiples of two spaces on line %d", index+1)
		}
		lines = append(lines, yamlLine{
			indent: indent,
			text:   strings.TrimSpace(withoutComment),
			line:   index + 1,
		})
	}
	return lines, nil
}

func (p *yamlParser) parseBlock(indent int) (any, error) {
	if p.pos >= len(p.lines) {
		return map[string]any{}, nil
	}
	line := p.lines[p.pos]
	if line.indent < indent {
		return map[string]any{}, nil
	}
	if line.indent != indent {
		return nil, fmt.Errorf("unexpected indentation on line %d", line.line)
	}
	if strings.HasPrefix(line.text, "- ") {
		return p.parseSequence(indent)
	}
	return p.parseMap(indent)
}

func (p *yamlParser) parseMap(indent int) (map[string]any, error) {
	out := map[string]any{}
	for p.pos < len(p.lines) {
		line := p.lines[p.pos]
		if line.indent < indent {
			break
		}
		if line.indent != indent {
			return nil, fmt.Errorf("unexpected indentation on line %d", line.line)
		}
		if strings.HasPrefix(line.text, "- ") {
			break
		}
		key, rawValue, ok := splitYAMLKeyValue(line.text)
		if !ok || key == "" {
			return nil, fmt.Errorf("expected mapping entry on line %d", line.line)
		}
		p.pos++
		value, err := p.parseMapValue(rawValue, indent, line.line)
		if err != nil {
			return nil, err
		}
		out[key] = value
	}
	return out, nil
}

func (p *yamlParser) parseSequence(indent int) ([]any, error) {
	values := []any{}
	for p.pos < len(p.lines) {
		line := p.lines[p.pos]
		if line.indent < indent {
			break
		}
		if line.indent != indent {
			return nil, fmt.Errorf("unexpected indentation on line %d", line.line)
		}
		if !strings.HasPrefix(line.text, "- ") {
			break
		}
		itemText := strings.TrimSpace(strings.TrimPrefix(line.text, "- "))
		p.pos++
		if itemText == "" {
			value, err := p.parseNestedValue(indent, line.line)
			if err != nil {
				return nil, err
			}
			values = append(values, value)
			continue
		}
		if key, rawValue, ok := splitYAMLKeyValue(itemText); ok {
			item := map[string]any{}
			value, err := p.parseMapValue(rawValue, indent, line.line)
			if err != nil {
				return nil, err
			}
			item[key] = value
			if err := p.parseMapFieldsInto(item, indent+2); err != nil {
				return nil, err
			}
			values = append(values, item)
			continue
		}
		value, err := parseYAMLScalar(itemText)
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", line.line, err)
		}
		values = append(values, value)
	}
	return values, nil
}

func (p *yamlParser) parseMapFieldsInto(out map[string]any, indent int) error {
	for p.pos < len(p.lines) {
		line := p.lines[p.pos]
		if line.indent < indent {
			return nil
		}
		if line.indent != indent {
			return fmt.Errorf("unexpected indentation on line %d", line.line)
		}
		if strings.HasPrefix(line.text, "- ") {
			return nil
		}
		key, rawValue, ok := splitYAMLKeyValue(line.text)
		if !ok || key == "" {
			return fmt.Errorf("expected mapping entry on line %d", line.line)
		}
		p.pos++
		value, err := p.parseMapValue(rawValue, indent, line.line)
		if err != nil {
			return err
		}
		out[key] = value
	}
	return nil
}

func (p *yamlParser) parseMapValue(rawValue string, indent int, lineNumber int) (any, error) {
	if strings.TrimSpace(rawValue) == "" {
		return p.parseNestedValue(indent, lineNumber)
	}
	if isYAMLBlockScalar(rawValue) {
		return p.parseBlockScalar(rawValue, indent)
	}
	value, err := parseYAMLScalar(rawValue)
	if err != nil {
		return nil, fmt.Errorf("line %d: %w", lineNumber, err)
	}
	return value, nil
}

func (p *yamlParser) parseBlockScalar(marker string, parentIndent int) (string, error) {
	chomp := byte(0)
	if strings.HasSuffix(marker, "-") || strings.HasSuffix(marker, "+") {
		chomp = marker[len(marker)-1]
	}
	if p.pos >= len(p.lines) || p.lines[p.pos].indent <= parentIndent {
		return "", nil
	}
	contentIndent := p.lines[p.pos].indent
	parts := []string{}
	for p.pos < len(p.lines) {
		line := p.lines[p.pos]
		if line.indent < contentIndent {
			break
		}
		if line.indent > contentIndent {
			parts = append(parts, strings.Repeat(" ", line.indent-contentIndent)+line.text)
		} else {
			parts = append(parts, line.text)
		}
		p.pos++
	}

	var value string
	if strings.HasPrefix(marker, ">") {
		value = strings.Join(parts, " ")
	} else {
		value = strings.Join(parts, "\n")
	}
	if chomp != '-' && value != "" {
		value += "\n"
	}
	return value, nil
}

func (p *yamlParser) parseNestedValue(parentIndent int, lineNumber int) (any, error) {
	if p.pos >= len(p.lines) || p.lines[p.pos].indent <= parentIndent {
		return map[string]any{}, nil
	}
	return p.parseBlock(p.lines[p.pos].indent)
}

func splitYAMLKeyValue(text string) (string, string, bool) {
	inSingle := false
	inDouble := false
	escaped := false
	for index, r := range text {
		if escaped {
			escaped = false
			continue
		}
		if inDouble && r == '\\' {
			escaped = true
			continue
		}
		switch r {
		case '\'':
			if !inDouble {
				inSingle = !inSingle
			}
		case '"':
			if !inSingle {
				inDouble = !inDouble
			}
		case ':':
			if inSingle || inDouble {
				continue
			}
			if index == len(text)-1 || text[index+1] == ' ' || text[index+1] == '\t' {
				return strings.TrimSpace(text[:index]), strings.TrimSpace(text[index+1:]), true
			}
		}
	}
	return "", "", false
}

func parseYAMLScalar(raw string) (any, error) {
	value := strings.TrimSpace(raw)
	switch value {
	case "":
		return "", nil
	case "null", "Null", "NULL", "~":
		return nil, nil
	case "true", "True", "TRUE":
		return true, nil
	case "false", "False", "FALSE":
		return false, nil
	case "{}":
		return map[string]any{}, nil
	case "[]":
		return []any{}, nil
	}
	if strings.HasPrefix(value, `"`) {
		unquoted, err := strconv.Unquote(value)
		if err != nil {
			return nil, err
		}
		return unquoted, nil
	}
	if strings.HasPrefix(value, `'`) && strings.HasSuffix(value, `'`) && len(value) >= 2 {
		return strings.ReplaceAll(value[1:len(value)-1], "''", "'"), nil
	}
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		return parseInlineYAMLSequence(value)
	}
	if number, err := strconv.ParseInt(value, 10, 64); err == nil {
		return number, nil
	}
	if number, err := strconv.ParseFloat(value, 64); err == nil && strings.ContainsAny(value, ".eE") {
		return number, nil
	}
	return value, nil
}

func isYAMLBlockScalar(raw string) bool {
	value := strings.TrimSpace(raw)
	if value == "|" || value == ">" || value == "|-" || value == ">-" || value == "|+" || value == ">+" {
		return true
	}
	return false
}

func parseInlineYAMLSequence(value string) ([]any, error) {
	inner := strings.TrimSpace(value[1 : len(value)-1])
	if inner == "" {
		return []any{}, nil
	}
	parts, err := splitInlineYAMLValues(inner)
	if err != nil {
		return nil, err
	}
	out := make([]any, 0, len(parts))
	for _, part := range parts {
		item, err := parseYAMLScalar(part)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

func splitInlineYAMLValues(value string) ([]string, error) {
	parts := []string{}
	start := 0
	inSingle := false
	inDouble := false
	escaped := false
	for index, r := range value {
		if escaped {
			escaped = false
			continue
		}
		if inDouble && r == '\\' {
			escaped = true
			continue
		}
		switch r {
		case '\'':
			if !inDouble {
				inSingle = !inSingle
			}
		case '"':
			if !inSingle {
				inDouble = !inDouble
			}
		case ',':
			if !inSingle && !inDouble {
				parts = append(parts, strings.TrimSpace(value[start:index]))
				start = index + 1
			}
		}
	}
	if inSingle || inDouble {
		return nil, fmt.Errorf("unterminated quoted inline sequence value")
	}
	parts = append(parts, strings.TrimSpace(value[start:]))
	return parts, nil
}

func stripYAMLComment(value string) string {
	inSingle := false
	inDouble := false
	escaped := false
	for index, r := range value {
		if escaped {
			escaped = false
			continue
		}
		if inDouble && r == '\\' {
			escaped = true
			continue
		}
		switch r {
		case '\'':
			if !inDouble {
				inSingle = !inSingle
			}
		case '"':
			if !inSingle {
				inDouble = !inDouble
			}
		case '#':
			if !inSingle && !inDouble {
				if index == 0 || value[index-1] == ' ' || value[index-1] == '\t' {
					return strings.TrimRight(value[:index], " \t")
				}
			}
		}
	}
	return value
}

func leadingSpaces(value string) int {
	count := 0
	for _, r := range value {
		if r != ' ' {
			break
		}
		count++
	}
	return count
}
