use super::*;

#[test]
fn generating_status() {
    let mut statuses = HashMap::new();
    assert!(apply_line("g /path/to/project", &mut statuses));
    assert_eq!(
        statuses.get("/path/to/project"),
        Some(&ClaudeStatus::Generating)
    );
}

#[test]
fn waiting_status() {
    let mut statuses = HashMap::new();
    assert!(apply_line("w /path/to/project", &mut statuses));
    assert_eq!(
        statuses.get("/path/to/project"),
        Some(&ClaudeStatus::Waiting)
    );
}

#[test]
fn complete_removes_entry() {
    let mut statuses = HashMap::new();
    apply_line("g /path/to/project", &mut statuses);
    assert!(apply_line("c /path/to/project", &mut statuses));
    assert!(statuses.is_empty());
}

#[test]
fn complete_on_nonexistent_returns_false() {
    let mut statuses = HashMap::new();
    assert!(!apply_line("c /path/to/project", &mut statuses));
}

#[test]
fn duplicate_status_returns_false() {
    let mut statuses = HashMap::new();
    apply_line("g /path/to/project", &mut statuses);
    assert!(!apply_line("g /path/to/project", &mut statuses));
}

#[test]
fn status_transition_generating_to_waiting() {
    let mut statuses = HashMap::new();
    apply_line("g /path/to/project", &mut statuses);
    assert!(apply_line("w /path/to/project", &mut statuses));
    assert_eq!(
        statuses.get("/path/to/project"),
        Some(&ClaudeStatus::Waiting)
    );
}

#[test]
fn multiple_projects() {
    let mut statuses = HashMap::new();
    apply_line("g /project-a", &mut statuses);
    apply_line("w /project-b", &mut statuses);
    assert_eq!(statuses.len(), 2);
    assert_eq!(
        statuses.get("/project-a"),
        Some(&ClaudeStatus::Generating)
    );
    assert_eq!(statuses.get("/project-b"), Some(&ClaudeStatus::Waiting));
}

#[test]
fn trailing_slash_stripped() {
    let mut statuses = HashMap::new();
    apply_line("g /path/to/project/", &mut statuses);
    assert_eq!(
        statuses.get("/path/to/project"),
        Some(&ClaudeStatus::Generating)
    );
}

#[test]
fn short_line_ignored() {
    let mut statuses = HashMap::new();
    assert!(!apply_line("g", &mut statuses));
    assert!(!apply_line("", &mut statuses));
    assert!(!apply_line("ab", &mut statuses));
}

#[test]
fn unknown_prefix_ignored() {
    let mut statuses = HashMap::new();
    assert!(!apply_line("x /path/to/project", &mut statuses));
}

#[test]
fn empty_project_ignored() {
    let mut statuses = HashMap::new();
    assert!(!apply_line("g ", &mut statuses));
}
