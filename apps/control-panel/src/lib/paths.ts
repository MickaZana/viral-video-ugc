export const APP_BASENAME = '/app'

export const paths = {
  home: '/',
  intel: '/intel',
  intelRemix: '/intel/remix',
  intelSource: (id: string) => `/intel/${encodeURIComponent(id)}`,
  studio: '/studio',
  studioScript: (id: string) => `/studio/script/${encodeURIComponent(id)}`,
  studioRun: (runId: string) => `/studio/runs/${encodeURIComponent(runId)}`,
  studioBatch: '/studio/batch',
  studioBatchProgress: (batchId: string) => `/studio/batch/${encodeURIComponent(batchId)}`,
  library: '/library',
  libraryItem: (id: string) => `/library/${encodeURIComponent(id)}`,
  review: '/review',
  reviewItem: (id: string) => `/review/${encodeURIComponent(id)}`,
  brand: '/brand',
  brandClient: (id: string) => `/brand/clients/${encodeURIComponent(id)}`,
  billing: '/billing',
  settings: '/settings',
  curriculum: '/curriculum',
  curriculumCourses: '/curriculum/courses',
  curriculumCourseNew: '/curriculum/courses/new',
  curriculumCourse: (id: string) => `/curriculum/courses/${encodeURIComponent(id)}`,
  curriculumModule: (courseId: string, moduleId: string) =>
    `/curriculum/courses/${encodeURIComponent(courseId)}/modules/${encodeURIComponent(moduleId)}`,
  curriculumLesson: (courseId: string, lessonId: string) =>
    `/curriculum/courses/${encodeURIComponent(courseId)}/lessons/${encodeURIComponent(lessonId)}`,
  curriculumLearn: '/curriculum/learn',
  curriculumLearnLesson: (courseId: string, lessonId: string) =>
    `/curriculum/learn/${encodeURIComponent(courseId)}/${encodeURIComponent(lessonId)}`,
  curriculumProjects: '/curriculum/projects',
  curriculumProduce: '/curriculum/produce',
  curriculumProduceCourse: (courseId: string) =>
    `/curriculum/produce/${encodeURIComponent(courseId)}`,
  curriculumSchedule: '/curriculum/schedule'
} as const

/** Legacy tab ids used by leftover EmptyState CTAs — map onto workspace paths. */
export const tabPath: Record<string, string> = {
  dashboard: paths.home,
  spy: paths.intel,
  rewriter: paths.studio,
  remix: paths.intelRemix,
  generator: paths.studio,
  history: paths.library,
  billing: paths.billing
}