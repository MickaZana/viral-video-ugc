import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { paths } from '../lib/paths'
import { CurriculumOverview } from './CurriculumOverview'
import { CourseList } from './CourseList'
import { CourseWizard } from './CourseWizard'
import { CourseOverview } from './CourseOverview'
import { ModuleView } from './ModuleView'
import { LessonView } from './LessonView'
import { LearnSection } from './LearnSection'
import { LessonLearnView } from './LessonLearnView'
import { ProduceSection } from './ProduceSection'
import { ProduceDashboard } from './ProduceDashboard'
import { ProjectsSection } from './ProjectsSection'
import { ScheduleSection } from './ScheduleSection'

const BARLOW = "'Barlow Condensed', 'Arial Narrow', sans-serif"

interface Tab {
  to: string
  label: string
  /** Only match the exact path (the OVERVIEW index tab). */
  end?: boolean
}

/** §47 sub-nav — the "COURRICULUM" typo in the spec is fixed here to COURSES. */
const TABS: Tab[] = [
  { to: paths.curriculum, label: 'Overview', end: true },
  { to: paths.curriculumCourses, label: 'Courses' },
  { to: paths.curriculumLearn, label: 'Learn' },
  { to: paths.curriculumProjects, label: 'Projects' },
  { to: paths.curriculumProduce, label: 'Produce' },
  { to: paths.curriculumSchedule, label: 'Schedule' }
]

/**
 * The enabled-mode Curriculum workspace: a horizontal sub-nav tab strip plus an
 * internal <Routes> tree. Mounted by App.tsx at `curriculum/*`, so every path
 * below is relative. WorkspaceLayout already renders the page <h1> ("Curriculum")
 * — the workspace keeps an <h2> as its own top heading.
 */
export function CurriculumWorkspace() {
  return (
    <section className="max-w-6xl space-y-6">
      <div className="space-y-2">
        <p className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-lime)]">
          Curriculum Mode Active
        </p>
        <h2
          className="text-4xl font-black uppercase"
          style={{ fontFamily: BARLOW, color: 'var(--color-text)' }}
        >
          Education Engine
        </h2>
      </div>

      <nav className="flex flex-wrap gap-x-6 gap-y-2 border-b border-[var(--color-border)] pb-0">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              [
                'pb-2 -mb-px border-b-2 text-[11px] font-mono uppercase tracking-widest transition-colors',
                isActive
                  ? 'border-[var(--color-lime)] text-[var(--color-lime)]'
                  : 'border-transparent text-[var(--color-muted-2)] hover:text-[var(--color-text)]'
              ].join(' ')
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route index element={<CurriculumOverview />} />
        <Route path="courses" element={<CourseList />} />
        <Route path="courses/new" element={<CourseWizard />} />
        <Route path="courses/:courseId" element={<CourseOverview />} />
        <Route path="courses/:courseId/modules/:moduleId" element={<ModuleView />} />
        <Route path="courses/:courseId/lessons/:lessonId" element={<LessonView />} />
        <Route path="learn" element={<LearnSection />} />
        <Route path="learn/:courseId/:lessonId" element={<LessonLearnView />} />
        <Route path="projects" element={<ProjectsSection />} />
        <Route path="produce" element={<ProduceSection />} />
        <Route path="produce/:courseId" element={<ProduceDashboard />} />
        <Route path="schedule" element={<ScheduleSection />} />
        <Route path="*" element={<Navigate to={paths.curriculum} replace />} />
      </Routes>
    </section>
  )
}
